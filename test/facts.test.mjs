// Tests for facts/validate.mjs: the real bundles must pass, and each class of
// violation the supervisor's checklist names must be caught by a fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, cpSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { validateFacts, parseSources, renderIndex } from "../facts/validate.mjs";

const FACTS = new URL("../facts/", import.meta.url).pathname;
const VALIDATE = join(FACTS, "validate.mjs");

/** Copy schema.json + sources.md into a temp dir and write the given bundles. */
function fixture(bundles, { sources } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "facts-test-"));
  cpSync(join(FACTS, "schema.json"), join(dir, "schema.json"));
  if (sources !== undefined) writeFileSync(join(dir, "sources.md"), sources);
  else cpSync(join(FACTS, "sources.md"), join(dir, "sources.md"));
  for (const [name, data] of Object.entries(bundles)) {
    writeFileSync(join(dir, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
  }
  return dir;
}

const good = (id, extra = {}) => ({
  id, value: 1, unit: "1", uncertainty: { type: "unstated" }, tier: "measured",
  source_ids: ["nssdc-mars-factsheet"], as_of: "2025-05", ...extra,
});
const bundle = (facts, name = "t") => ({ bundle: name, version: "0.0.1", facts });
const errorsOf = dir => validateFacts(dir).errors;
const hasError = (dir, re) => assert.ok(errorsOf(dir).some(e => re.test(e)), `expected /${re.source}/ in:\n${errorsOf(dir).join("\n")}`);

test("the committed bundles validate with no errors", () => {
  const r = validateFacts(FACTS);
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
  assert.ok(r.index.ids.length > 20);
});

test("the committed index.json is current", () => {
  const r = validateFacts(FACTS);
  assert.equal(readFileSync(join(FACTS, "index.json"), "utf8"), renderIndex(r.index));
});

test("index maps every id to its record and bundle, in file order", () => {
  const dir = fixture({ "a.json": bundle([good("x.one"), good("x.two")], "alpha"), "b.json": bundle([good("y.one")], "beta") });
  const { index } = validateFacts(dir);
  assert.deepEqual(index.ids, ["x.one", "x.two", "y.one"]);
  assert.equal(index.facts["y.one"].bundle, "beta");
  assert.deepEqual(index.bundles.alpha, { file: "a.json", version: "0.0.1", description: "", fact_count: 2 });
  assert.deepEqual(index.sources["nssdc-mars-factsheet"].cited_by, ["x.one", "x.two", "y.one"]);
  rmSync(dir, { recursive: true });
});

test("schema violation: missing uncertainty", () => {
  const f = good("x.bad"); delete f.uncertainty;
  hasError(fixture({ "t.json": bundle([f]) }), /must have required property 'uncertainty'/);
});

test("schema violation: unknown field and bad tier", () => {
  const dir = fixture({ "t.json": bundle([good("x.bad", { tier: "fact", extra_field: 1 })]) });
  hasError(dir, /additional properties \(extra_field\)/);
  hasError(dir, /tier: must be equal to one of the allowed values/);
});

test("invalid JSON fails", () => {
  hasError(fixture({ "t.json": "{ not json" }), /invalid JSON/);
});

test("duplicate ids across bundles", () => {
  hasError(fixture({ "a.json": bundle([good("x.dup")], "a"), "b.json": bundle([good("x.dup")], "b") }), /duplicate id "x.dup"/);
});

test("source id that has no heading in sources.md", () => {
  hasError(fixture({ "t.json": bundle([good("x.s", { source_ids: ["made-up-2026"] })]) }), /"made-up-2026" has no "## made-up-2026" heading/);
});

test("citing a design/architecture (R) reference as a fact source", () => {
  hasError(fixture({ "t.json": bundle([good("x.r", { source_ids: ["nasa-dra5"] })]) }), /"nasa-dra5" is a design\/architecture reference/);
});

test("depends_on, superseded_by and competing_with must resolve", () => {
  const dir = fixture({ "t.json": bundle([
    good("x.a", { depends_on: ["x.missing"] }),
    good("x.b", { superseded_by: "x.gone" }),
    good("x.c", { competing_with: ["x.a", "x.nope"] }),
    good("x.d", { depends_on: ["x.d"] }),
  ]) });
  hasError(dir, /x\.a: depends_on "x.missing" does not resolve/);
  hasError(dir, /x\.b: superseded_by "x.gone" does not resolve/);
  hasError(dir, /x\.c: competing_with "x.nope" does not resolve/);
  hasError(dir, /x\.d: depends_on refers to itself/);
  assert.ok(!errorsOf(dir).some(e => /"x\.a" does not resolve/.test(e)), "x.a exists and must resolve");
});

test("dependency cycles are rejected", () => {
  const dir = fixture({ "t.json": bundle([
    good("x.a", { tier: "derived", formula: "b", depends_on: ["x.b"] }),
    good("x.b", { tier: "derived", formula: "a", depends_on: ["x.a"] }),
  ]) });
  hasError(dir, /dependency cycle: x\.a -> x\.b -> x\.a/);
});

test("derived records need formula and depends_on", () => {
  const dir = fixture({ "t.json": bundle([
    good("x.base"),
    good("x.noformula", { tier: "derived", depends_on: ["x.base"] }),
    good("x.nodeps", { tier: "derived", formula: "x.base * 2" }),
    good("x.emptyformula", { tier: "derived", formula: "  ", depends_on: ["x.base"] }),
    good("x.emptydeps", { tier: "derived", formula: "x", depends_on: [] }),
  ]) });
  hasError(dir, /x\.noformula.*must have required property 'formula'/);
  hasError(dir, /x\.nodeps.*must have required property 'depends_on'/);
  // the two schema failures above take the whole bundle out of the index; check the
  // non-schema rules in a bundle that passes the schema
  const dir2 = fixture({ "t.json": bundle([
    good("x.base"),
    good("x.emptyformula", { tier: "derived", formula: "  ", depends_on: ["x.base"] }),
    good("x.emptydeps", { tier: "derived", formula: "x", depends_on: [] }),
  ]) });
  hasError(dir2, /x\.emptyformula: derived record needs a non-empty formula/);
  hasError(dir2, /x\.emptydeps: derived record needs a non-empty depends_on/);
});

test("warnings: untraceable formula literal, APPROX, uncited source", () => {
  const dir = fixture({ "t.json": bundle([
    good("x.base", { value: 686.98 }),
    good("x.d", { tier: "derived", formula: "686.98 * 1361 / 2", depends_on: ["x.base"] }),
    good("x.approx", { notes: "APPROX. Agent task F2." }),
  ]) });
  const r = validateFacts(dir);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some(w => /x\.d: formula uses 1361 which is not the value of any depends_on record/.test(w)), r.warnings.join("\n"));
  assert.ok(!r.warnings.some(w => /formula uses.*686\.98/.test(w)), "686.98 is a depends_on value and must not warn");
  assert.ok(r.warnings.some(w => /x\.approx: marked APPROX/.test(w)));
  assert.ok(r.warnings.some(w => /"meda-pds-archive" is not cited by any fact/.test(w)));
});

test("parseSources: headings, (R) section and Use: **R** lines", () => {
  const md = "# Sources\n\n## alpha-2020\nUse: **F** x\n\n## beta-2021\nUse: **R** reading only\n\n# Design references (R)\n\n## gamma-2009\nWhy it matters: ...\n";
  const s = parseSources(md);
  assert.deepEqual([...s.ids], ["alpha-2020", "beta-2021", "gamma-2009"]);
  assert.deepEqual([...s.referenceOnly], ["beta-2021", "gamma-2009"]);
});

test("CLI: exit 1 on a bad record, exit 0 and writes index on good input, --check detects stale index", () => {
  const bad = fixture({ "t.json": bundle([good("x.bad", { source_ids: ["nope"] })]) });
  let r = spawnSync(process.execPath, [VALIDATE, "--dir", bad, "--quiet"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"nope" has no "## nope" heading/);

  const ok = fixture({ "t.json": bundle([good("x.ok")]) });
  r = spawnSync(process.execPath, [VALIDATE, "--dir", ok], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok: 1 bundle\(s\), 1 fact\(s\), 0 error\(s\)/m);
  const index = JSON.parse(readFileSync(join(ok, "index.json"), "utf8"));
  assert.deepEqual(index.ids, ["x.ok"]);

  r = spawnSync(process.execPath, [VALIDATE, "--dir", ok, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);

  writeFileSync(join(ok, "t.json"), JSON.stringify(bundle([good("x.ok"), good("x.new")])));
  r = spawnSync(process.execPath, [VALIDATE, "--dir", ok, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /index\.json is stale/);
  // --check must not have rewritten the index
  assert.deepEqual(JSON.parse(readFileSync(join(ok, "index.json"), "utf8")).ids, ["x.ok"]);
});
