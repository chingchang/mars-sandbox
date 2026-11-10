// Read a Wasm binary's linear-memory declarations without instantiating it. The
// JS API does not expose them, so parse the import (id 2) and memory (id 5)
// sections. Returns a list of { min, max, imported, flag } for EVERY memory the
// module declares or imports (multi-memory is accepted by current engines), or
// throws on a malformed header or an unsupported limits flag.
//
// Limits flags: 0 = min only, 1 = min+max, 2/3 = shared (needs max), bit 0x04 =
// memory64. memory64 limits are u64 and would wrap a u32 reader (2^35 pages would
// parse as 8), so the flag is rejected outright rather than misread.
export const FLAG_MEMORY64 = 0x04;

export function memoryLimits(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || u8[0] !== 0 || u8[1] !== 0x61 || u8[2] !== 0x73 || u8[3] !== 0x6d) throw new Error("not a wasm binary");
  let p = 8;
  const u32 = () => { let r = 0, s = 0, b, n = 0; do { if (p >= u8.length || ++n > 5) throw new Error("malformed LEB128"); b = u8[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  const limits = (imported) => {
    const flag = u8[p++];
    if (flag & FLAG_MEMORY64) throw new Error("memory64 is not allowed");
    if (flag > 3) throw new Error(`unknown memory limits flag ${flag}`);
    const min = u32(); const max = (flag & 1) ? u32() : null;
    return { min, max, imported, flag };
  };
  const name = () => { const n = u32(); p += n; };
  const found = [];
  while (p < u8.length) {
    const id = u8[p++], size = u32(), end = p + size;
    if (end > u8.length) throw new Error("truncated section");
    if (id === 2) {
      const count = u32();
      for (let i = 0; i < count; i++) {
        name(); name(); const kind = u8[p++];
        if (kind === 0) u32();                                  // func: type index
        else if (kind === 1) { p++; limits(true); }             // table: elemtype + limits (not a memory)
        else if (kind === 2) found.push(limits(true));          // memory
        else if (kind === 3) p += 2;                            // global: valtype + mutability
        else throw new Error(`unknown import kind ${kind}`);
      }
    } else if (id === 5) {
      const count = u32();
      for (let i = 0; i < count; i++) found.push(limits(false));
    }
    p = end;
  }
  return found;
}

/** Apply the sandbox's memory policy; returns null if acceptable, else the reason. */
export function memoryPolicy(bytes, maxPages) {
  let mems;
  try { mems = memoryLimits(bytes); } catch (e) { return e.message; }
  if (mems.length > 1) return `module declares ${mems.length} memories; exactly one is allowed`;
  const m = mems[0];
  if (!m) return null;                                          // no linear memory at all: nothing to grow
  if (m.imported) return "imported memory is not allowed";
  if (m.max === null) return "module declares no maximum memory (compile with --maximumMemory)";
  if (m.max > maxPages) return `module declares maximum memory ${m.max} pages, ceiling is ${maxPages}`;
  return null;
}
