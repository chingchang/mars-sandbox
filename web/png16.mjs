// Minimal decoder for 16-bit greyscale PNGs (the heightmap format written by
// terrain/*.py). Canvas drawImage() would truncate to 8 bits, so we inflate the
// IDAT stream with DecompressionStream and undo the scanline filters ourselves.
// Works in browsers and in Node >= 18 (used by test/terrain.test.mjs).
export async function decodePng16(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => u8[i] === b)) throw new Error("not a PNG");
  let p = 8, w = 0, h = 0, depth = 0, color = 0; const idat = [];
  while (p + 8 <= u8.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(u8[p+4], u8[p+5], u8[p+6], u8[p+7]);
    const data = u8.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = u8[p + 16]; color = u8[p + 17]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 16 || color !== 0) throw new Error(`expected 16-bit greyscale PNG, got bit depth ${depth}, colour type ${color}`);
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const bpp = 2, stride = w * bpp;
  if (raw.length !== h * (stride + 1)) throw new Error(`inflated ${raw.length} bytes, expected ${h * (stride + 1)}`);
  const out = new Uint16Array(w * h);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      else if (ft !== 0) throw new Error(`bad filter ${ft} on row ${y}`);
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) out[y * w + x] = (cur[2 * x] << 8) | cur[2 * x + 1];
    [prev, cur] = [cur, prev];
  }
  return { width: w, height: h, data: out };
}

// Turn a decoded heightmap plus its sidecar into a sampler. World frame: x east,
// z south (north is -z), y up, origin at the sidecar's centre pixel (the landing
// site), so y = 0 is the site's own elevation; `siteElevation` is its height
// above the datum for display.
export function makeSampler(img, meta) {
  const { offset_m, scale_m } = meta.encoding, res = meta.grid.resolution_m, n = img.width;
  const [cc, cr] = meta.grid.centre_pixel;
  const site = offset_m + scale_m * img.data[cr * n + cc];
  const at = (r, c) => offset_m + scale_m * img.data[Math.min(n - 1, Math.max(0, r)) * n + Math.min(n - 1, Math.max(0, c))] - site;
  const h = (x, z) => {
    const col = cc + x / res, row = cr + z / res, r0 = Math.floor(row), c0 = Math.floor(col), fr = row - r0, fc = col - c0;
    return (at(r0, c0) * (1 - fr) + at(r0 + 1, c0) * fr) * (1 - fc) + (at(r0, c0 + 1) * (1 - fr) + at(r0 + 1, c0 + 1) * fr) * fc;
  };
  return { h, size: (n - 1) * res, res, siteElevation: site, meta };
}
