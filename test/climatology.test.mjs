// jezero_climatology.json: every MCD record is a well-formed table whose series
// match its axes, whose RMS (when present) matches the series shape, and whose
// physical values are in range.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bundle = JSON.parse(readFileSync(new URL("../facts/jezero_climatology.json", import.meta.url), "utf8"));
const RANGES = { t: [140, 320], tsurf: [130, 330], ps: [400, 1100], fluxsurf_dn_sw: [0, 800], fluxsurf_lw: [0, 400], tauref: [0, 10] };

test("bundle has 3 scenarios x 6 variables", () => {
  const ids = bundle.facts.map(f => f.id);
  for (const s of ["clim_ave", "storm_ave", "my36"]) for (const v of Object.keys(RANGES)) assert.ok(ids.includes(`jezero.climate.mcd62.${s}.${v}`), `${s}.${v}`);
  assert.equal(bundle.facts.length, 18);
});

for (const f of bundle.facts) {
  test(`${f.id}: table shape, RMS shape, ranges`, () => {
    const v = f.value, nLs = v.axes.ls_deg.length, nH = v.axes.local_time_ltst_h.length;
    assert.equal(nH, 25); assert.deepEqual(v.axes.local_time_ltst_h.slice(0, 3), [0, 1, 2]);
    assert.equal(v.scenario.name.length > 0, true);
    assert.equal(nLs, f.id.includes("storm_ave") ? 6 : 12);
    assert.equal(v.series.length, nLs);
    for (const row of v.series) assert.equal(row.length, nH);
    if (v.day_to_day_rms) { assert.equal(f.uncertainty.type, "series"); assert.equal(v.day_to_day_rms.length, nLs); for (const row of v.day_to_day_rms) assert.equal(row.length, nH); }
    else assert.equal(f.uncertainty.type, "unstated");
    const [lo, hi] = RANGES[v.variable];
    for (const row of v.series) for (const x of row) assert.ok(x >= lo && x <= hi, `${f.id}: ${x} outside ${lo}..${hi}`);
    // hour 24 repeats hour 0 (periodic diurnal profile)
    for (const row of v.series) assert.ok(Math.abs(row[24] - row[0]) < 1e-6);
    assert.equal(f.tier, "modeled");
    assert.match(f.notes, /derive: facts\/derive\/out\/mcd62_jezero\.json#records\./);
  });
}

test("solar flux is zero at night and peaks near local noon", () => {
  const f = bundle.facts.find(x => x.id === "jezero.climate.mcd62.clim_ave.fluxsurf_dn_sw");
  for (const row of f.value.series) {
    assert.equal(row[0], 0); assert.equal(row[2], 0); assert.equal(row[22], 0);
    const peak = row.indexOf(Math.max(...row)); assert.ok(peak >= 11 && peak <= 13, `peak at ${peak} h`);
  }
});
