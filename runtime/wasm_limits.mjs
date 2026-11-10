// Read a Wasm binary's linear-memory limits without instantiating it. The JS API
// does not expose them, so parse the import (id 2) and memory (id 5) sections.
// Returns { min, max, imported } in pages, or throws on a malformed header.
export function memoryLimits(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || u8[0] !== 0 || u8[1] !== 0x61 || u8[2] !== 0x73 || u8[3] !== 0x6d) throw new Error("not a wasm binary");
  let p = 8;
  const u32 = () => { let r = 0, s = 0, b; do { b = u8[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  const limits = () => { const flag = u8[p++]; const min = u32(); const max = (flag & 1) ? u32() : null; return { min, max }; };
  const name = () => { const n = u32(); p += n; };
  let found = null;
  while (p < u8.length) {
    const id = u8[p++], size = u32(), end = p + size;
    if (id === 2) {                                   // imports: look for an imported memory
      const count = u32();
      for (let i = 0; i < count; i++) {
        name(); name(); const kind = u8[p++];
        if (kind === 0) u32(); else if (kind === 1) { p++; limits(); } else if (kind === 2) { found = { ...limits(), imported: true }; } else if (kind === 3) p += 2;
      }
    } else if (id === 5) {
      const count = u32();
      if (count > 0) found = { ...limits(), imported: false };
    }
    p = end;
  }
  return found;
}
