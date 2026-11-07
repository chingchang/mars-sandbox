// Terrain products (task T1): every heightmap in web/terrain has a sidecar with
// datum, scale, source and version; the PNG decodes to the elevations the sidecar
// claims; and the sampler used by the client agrees with the raw pixels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodePng16, makeSampler } from "../web/png16.mjs";

const DIR = new URL("../web/terrain/", import.meta.url).pathname;
const products = readdirSync(DIR).filter(f => f.endsWith(".png")).map(f => f.slice(0, -4));
assert.ok(products.length >= 1, "no terrain products in web/terrain");

for (const name of products) {
  test(`${name}: sidecar carries datum, scale, source and version`, () => {
    const meta = JSON.parse(readFileSync(join(DIR, name + ".json"), "utf8"));
    assert.equal(meta.product, name + ".png");
    assert.ok(meta.datum?.vertical && meta.datum?.horizontal && meta.datum?.sphere_radius_m > 3e6, "datum");
    assert.ok(meta.grid?.resolution_m > 0 && meta.grid.width > 1 && meta.grid.height === meta.grid.width, "grid");
    assert.equal(meta.encoding.dtype, "uint16");
    assert.ok(meta.encoding.scale_m > 0 && typeof meta.encoding.offset_m === "number", "encoding");
    assert.ok(meta.source_id && (meta.source.product_version_id || meta.source.doi), "source + version");
    assert.ok(meta.source.img_sha256 || meta.source.fetched_sha256, "source bytes hashed");
    assert.equal(meta.projection.centre.fact_id, "jezero.location.landing_site");
    assert.match(meta.facts_content_hash, /^[0-9a-f]{64}$/);
  });

  test(`${name}: PNG decodes to the sidecar's elevations`, async () => {
    const meta = JSON.parse(readFileSync(join(DIR, name + ".json"), "utf8"));
    const img = await decodePng16(readFileSync(join(DIR, name + ".png")));
    assert.equal(img.width, meta.grid.width); assert.equal(img.height, meta.grid.height);
    let lo = 65535, hi = 0;
    for (const v of img.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const { offset_m: o, scale_m: s } = meta.encoding;
    assert.ok(Math.abs(o + s * lo - meta.elevation_m.min) <= s, `min ${o + s * lo} vs ${meta.elevation_m.min}`);
    assert.ok(Math.abs(o + s * hi - meta.elevation_m.max) <= s, `max ${o + s * hi} vs ${meta.elevation_m.max}`);
    const [cc, cr] = meta.grid.centre_pixel;
    assert.ok(Math.abs(o + s * img.data[cr * img.width + cc] - meta.elevation_m.centre) <= s, "centre");
  });

  test(`${name}: sampler is zero at the site, interpolates, and matches pixels`, async () => {
    const meta = JSON.parse(readFileSync(join(DIR, name + ".json"), "utf8"));
    const img = await decodePng16(readFileSync(join(DIR, name + ".png")));
    const t = makeSampler(img, meta);
    assert.ok(Math.abs(t.siteElevation - meta.elevation_m.centre) <= meta.encoding.scale_m);
    assert.equal(t.h(0, 0), 0);
    assert.equal(t.size, (meta.grid.width - 1) * meta.grid.resolution_m);
    const res = meta.grid.resolution_m, [cc, cr] = meta.grid.centre_pixel, { offset_m: o, scale_m: s } = meta.encoding;
    // one pixel east and one pixel south (world +z) read the raw grid exactly
    const east = o + s * img.data[cr * img.width + cc + 1] - t.siteElevation;
    const south = o + s * img.data[(cr + 1) * img.width + cc] - t.siteElevation;
    assert.ok(Math.abs(t.h(res, 0) - east) < 1e-9); assert.ok(Math.abs(t.h(0, res) - south) < 1e-9);
    // halfway is the mean of the two neighbours (bilinear)
    assert.ok(Math.abs(t.h(res / 2, 0) - east / 2) < 1e-9);
    // the MOLA crater floor should be below the rim: a 40 km product must span > 500 m; a 5 km one need not
    if (name.includes("40km")) assert.ok(meta.elevation_m.max - meta.elevation_m.min > 500);
  });
}

test("PNG16 decoder rejects non-16-bit input", async () => {
  await assert.rejects(decodePng16(new Uint8Array([1, 2, 3])), /not a PNG/);
});
