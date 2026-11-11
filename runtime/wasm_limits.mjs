// Inspect a Wasm binary's resource declarations without instantiating it, and
// apply the sandbox's memory policy before WebAssembly.compile. The JS API does
// not expose any of this, so the type (id 1), import (id 2), table (id 4) and
// memory (id 5) sections are parsed directly.
//
// The policy bounds everything a module can allocate:
//   - exactly one linear memory (or none), not imported, 32-bit, with a declared
//     maximum of at most MAX_MEMORY_PAGES (multi-memory would be a second door);
//   - only plain function types in the type section: no struct, array, rec or
//     sub types, so no WasmGC allocation is possible;
//   - any table must declare a maximum of at most MAX_TABLE_ELEMENTS and may not
//     be imported (a growing funcref table is memory too).
// Limits flags: 0 = min only, 1 = min+max, 2/3 = shared (memory only), bit 0x04
// = 64-bit. 64-bit limits are u64 and would wrap a u32 reader, so the flag is
// rejected outright rather than misread.
export const FLAG_64 = 0x04;
export const MAX_TABLE_ELEMENTS = 256;
const FUNC_TYPE = 0x60;

export function inspectModule(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || u8[0] !== 0 || u8[1] !== 0x61 || u8[2] !== 0x73 || u8[3] !== 0x6d) throw new Error("not a wasm binary");
  let p = 8;
  const u32 = () => { let r = 0, s = 0, b, n = 0; do { if (p >= u8.length || ++n > 5) throw new Error("malformed LEB128"); b = u8[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  const skipLeb = () => { let b, n = 0; do { if (p >= u8.length || ++n > 10) throw new Error("malformed LEB128"); b = u8[p++]; } while (b & 0x80); };
  const valtype = () => { const b = u8[p++]; if (b === 0x63 || b === 0x64) skipLeb(); };          // (ref null ht) / (ref ht) carry a heap type
  const limits = (what, imported) => {
    const flag = u8[p++];
    if (flag & FLAG_64) throw new Error(`${what}64 is not allowed`);
    if (what === "memory" ? flag > 3 : flag > 1) throw new Error(`unknown ${what} limits flag ${flag}`);
    const min = u32(); const max = (flag & 1) ? u32() : null;
    return { min, max, imported, flag };
  };
  const name = () => { const n = u32(); p += n; };
  const out = { memories: [], tables: [], nonFunctionTypes: 0, typeCount: 0 };
  while (p < u8.length) {
    const id = u8[p++], size = u32(), end = p + size;
    if (end > u8.length) throw new Error("truncated section");
    if (id === 1) {
      const count = u32(); out.typeCount = count;
      for (let i = 0; i < count; i++) {
        const form = u8[p++];
        if (form !== FUNC_TYPE) { out.nonFunctionTypes = count - i; break; }   // struct/array/rec/sub: stop parsing, the policy rejects it
        const np = u32(); for (let j = 0; j < np; j++) valtype();
        const nr = u32(); for (let j = 0; j < nr; j++) valtype();
      }
    } else if (id === 2) {
      const count = u32();
      for (let i = 0; i < count; i++) {
        name(); name(); const kind = u8[p++];
        if (kind === 0) u32();                                               // func: type index
        else if (kind === 1) { valtype(); out.tables.push(limits("table", true)); }
        else if (kind === 2) out.memories.push(limits("memory", true));
        else if (kind === 3) p += 2;                                         // global: valtype + mutability (numeric types only in practice)
        else throw new Error(`unknown import kind ${kind}`);
      }
    } else if (id === 4) {
      const count = u32();
      for (let i = 0; i < count; i++) { valtype(); out.tables.push(limits("table", false)); }
    } else if (id === 5) {
      const count = u32();
      for (let i = 0; i < count; i++) out.memories.push(limits("memory", false));
    }
    p = end;
  }
  return out;
}

/** Every linear memory the module declares or imports (kept for callers that only care about memory). */
export function memoryLimits(bytes) { return inspectModule(bytes).memories; }

/** Apply the sandbox's resource policy; returns null if acceptable, else the reason. */
export function memoryPolicy(bytes, maxPages, maxTable = MAX_TABLE_ELEMENTS) {
  let m;
  try { m = inspectModule(bytes); } catch (e) { return e.message; }
  if (m.nonFunctionTypes > 0) return `module declares ${m.nonFunctionTypes} non-function type(s) (struct, array, rec or sub); only plain function types are allowed`;
  if (m.memories.length > 1) return `module declares ${m.memories.length} memories; exactly one is allowed`;
  const mem = m.memories[0];
  if (mem) {
    if (mem.imported) return "imported memory is not allowed";
    if (mem.max === null) return "module declares no maximum memory (compile with --maximumMemory)";
    if (mem.max > maxPages) return `module declares maximum memory ${mem.max} pages, ceiling is ${maxPages}`;
  }
  for (const t of m.tables) {
    if (t.imported) return "imported table is not allowed";
    if (t.max === null) return "table declares no maximum size";
    if (t.max > maxTable) return `table declares maximum ${t.max} entries, ceiling is ${maxTable}`;
  }
  return null;
}
