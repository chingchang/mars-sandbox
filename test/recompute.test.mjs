// facts/derive/recompute.mjs: derived records recompute from depends_on, and a
// wrong stored value, a bad formula, or a non-numeric dependency is an error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { recompute, compileFormula, NOT_EVALUABLE } from "../facts/derive/recompute.mjs";

const INDEX = new URL("../facts/index.json", import.meta.url).pathname;
const SCRIPT = new URL("../facts/derive/recompute.mjs", import.meta.url).pathname;

const rec = (id, value, extra = {}) => [id, { id, value, tier: "measured", uncertainty: { type: "unstated" }, ...extra }];
const idx = (...entries) => ({ facts: Object.fromEntries(entries) });

test("the committed index recomputes with no errors", () => {
  const r = recompute(JSON.parse(readFileSync(INDEX, "utf8")));
  const errors = r.filter(x => x.status === "error");
  assert.deepEqual(errors, []);
  assert.ok(r.filter(x => x.status === "ok").length >= 5);
  for (const s of r.filter(x => x.status === "skipped")) assert.ok(s.id in NOT_EVALUABLE);
});

test("compileFormula: ids, literals, ^, pi, functions; rejects unknown tokens", () => {
  const byId = { "a.b": {}, "c.d_e": {} };
  assert.equal(compileFormula("a.b * (c.d_e + 2)^2 / pi", byId), 'v["a.b"] * ( v["c.d_e"] + 2 ) ** 2 / c.pi');
  assert.equal(compileFormula("sqrt(a.b) * 86400", byId), 'f.sqrt ( v["a.b"] ) * 86400');
  assert.equal(compileFormula("a.b * x.unknown", byId), null);
  assert.equal(compileFormula("sum(x_i * M_i) over CO2", byId), null);
  assert.equal(compileFormula("a.b; process.exit(1)", byId), null);
});

test("agreement within uncertainty passes; outside fails; prose formula errors unless listed", () => {
  const base = rec("x.base", 100, { uncertainty: { type: "plus_minus", value: 1 } });
  const ok = rec("x.ok", 200, { tier: "derived", formula: "x.base * 2", depends_on: ["x.base"], uncertainty: { type: "plus_minus", value: 1 } });
  const rounded = rec("x.round", 333.3, { tier: "derived", formula: "x.base * 10 / 3", depends_on: ["x.base"], uncertainty: { type: "unstated" } });
  const bad = rec("x.bad", 250, { tier: "derived", formula: "x.base * 2", depends_on: ["x.base"], uncertainty: { type: "plus_minus", value: 1 } });
  const prose = rec("x.prose", 1, { tier: "derived", formula: "skin depth from thermal inertia", depends_on: ["x.base"] });
  const r = Object.fromEntries(recompute(idx(base, ok, rounded, bad, prose)).map(x => [x.id, x]));
  assert.equal(r["x.ok"].status, "ok");
  assert.equal(r["x.round"].status, "ok", r["x.round"].message);      // half a ulp of 333.3 covers 333.333
  assert.equal(r["x.bad"].status, "error"); assert.match(r["x.bad"].message, /differs by 50/);
  assert.equal(r["x.prose"].status, "error");
  assert.equal(r["x.base"], undefined, "measured records are not recomputed");
});

test("non-numeric dependency is an error", () => {
  const txt = rec("x.txt", "low");
  const d = rec("x.d", 1, { tier: "derived", formula: "x.txt * 2", depends_on: ["x.txt"] });
  const r = recompute(idx(txt, d));
  assert.ok(r.some(x => x.id === "x.d" && x.status === "error"));
});

test("CLI exits 0 on the committed index", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok: \d+ derived record\(s\), 0 error\(s\)$/m);
});
