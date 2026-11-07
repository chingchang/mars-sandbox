// Tests for facts/validate.mjs: the real bundles must pass, and each class of
// violation the supervisor's checklist names must be caught by a fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, cpSync, readFileSync, rmSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { validateFacts, parseSources, renderIndex, formulaLiterals, TIER_ORDER } from "../facts/validate.mjs";

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
  assert.ok(r.index.ids.includes("sun.solar_constant_1au") && r.index.ids.includes("astro.au"));
  assert.equal(r.index.facts["astro.au"].tier, "defined");
  assert.equal(r.index.facts["chem.molar_mass.ar40"].tier_rank, 1);
});

test("the committed index.json is current", () => {
  const r = validateFacts(FACTS);
  assert.equal(readFileSync(join(FACTS, "index.json"), "utf8"), renderIndex(r.index));
});

test("index maps every id to its record and bundle, in file order", () => {
  const dir = fixture({ "a.json": bundle([good("x.one"), good("x.two")], "alpha"), "b.json": bundle([good("y.one")], "beta") });
  const { index } = validateFacts(dir);
  const pkg = basename(dir);   // no package.json in the fixture, so the folder name is the package name
  assert.deepEqual(index.ids, ["x.one", "x.two", "y.one"]);
  assert.equal(index.facts["y.one"].bundle, "beta");
  assert.deepEqual(index.bundles.alpha, { file: "a.json", package: pkg, version: "0.0.1", description: "", fact_count: 2 });
  assert.deepEqual(index.sources["nssdc-mars-factsheet"].cited_by, ["x.one", "x.two", "y.one"]);
  assert.equal(index.facts["x.one"].package, pkg);
  assert.equal(index.facts["x.one"].tier_rank, 1);
  assert.deepEqual(index.tier_order, ["defined", "measured", "derived", "engineering", "modeled", "hypothesis"]);
  assert.deepEqual(index.packages, { [pkg]: { root: ".", bundles: ["alpha", "beta"] } });
  assert.match(index.content_hash, /^[0-9a-f]{64}$/);
  rmSync(dir, { recursive: true });
});

test("index carries source citations parsed from sources.md", () => {
  const dir = fixture({ "t.json": bundle([good("x.one")]) });
  const { index } = validateFacts(dir);
  const src = index.sources["nssdc-mars-factsheet"];
  assert.match(src.citation, /^NASA NSSDCA Planetary Fact Sheet: Mars/);
  assert.deepEqual(src.urls, ["https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html"]);
  assert.deepEqual(src.use, ["F"]);
  assert.equal(src.verified, "2026-11-05");
  assert.equal(src.reference_only, false);
  const ref = index.sources["nasa-dra5"];
  assert.equal(ref.reference_only, true);
  assert.deepEqual(ref.use, ["R"]);
  assert.ok(ref.urls.length >= 2);
});

test("content_hash changes with content and is stable otherwise", () => {
  const dir = fixture({ "t.json": bundle([good("x.one")]) });
  const h1 = validateFacts(dir).index.content_hash;
  assert.equal(validateFacts(dir).index.content_hash, h1);
  writeFileSync(join(dir, "t.json"), JSON.stringify(bundle([good("x.one", { value: 2 })])));
  assert.notEqual(validateFacts(dir).index.content_hash, h1);
});

test("two package roots validate together; ids may depend across packages", () => {
  const base = fixture({ "base.json": bundle([good("x.base")], "base") });
  const ext = mkdtempSync(join(tmpdir(), "facts-ext-"));
  writeFileSync(join(ext, "package.json"), JSON.stringify({ name: "lab-crops" }));
  writeFileSync(join(ext, "sources.md"), "# Sources\n\n## lab-paper-2026\nLab et al. (2026). A crop model. https://example.org/paper\nUse: **F** crops. Verified 2026-11-06.\n");
  writeFileSync(join(ext, "crops.json"), JSON.stringify(bundle([
    good("crop.yield", { tier: "derived", formula: "x.base * 2", depends_on: ["x.base"], source_ids: ["lab-paper-2026"] }),
  ], "lab-crops-bundle")));
  const r = validateFacts([base, ext]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.index.ids, ["x.base", "crop.yield"]);
  assert.equal(r.index.facts["crop.yield"].package, "lab-crops");
  assert.equal(r.index.packages["lab-crops"].root, relative(base, ext));
  assert.deepEqual(r.index.sources["lab-paper-2026"].cited_by, ["crop.yield"]);
  // a duplicate id across packages is an error
  writeFileSync(join(ext, "crops.json"), JSON.stringify(bundle([good("x.base", { source_ids: ["lab-paper-2026"] })], "lab-crops-bundle")));
  assert.ok(validateFacts([base, ext]).errors.some(e => /duplicate id "x.base"/.test(e)));
  // base alone does not know the extension's source
  assert.ok(validateFacts(base).ok);
  const r2 = spawnSync(process.execPath, [VALIDATE, "--dir", base, "--dir", ext, "--quiet"], { encoding: "utf8" });
  assert.equal(r2.status, 1, "cli: duplicate id must fail");
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

test("formula literals: depends_on values, small integers and unit conversions pass; anything else is an error", () => {
  const dir = fixture({ "t.json": bundle([
    good("x.base", { value: 686.98 }),
    good("x.obj", { value: { lat: 18.44, lon_e: 77.45 } }),
    good("x.ok", { tier: "derived", formula: "x.base * 86400 / 1000 * 2 * pi * 18.44 + 686.98^2", depends_on: ["x.base", "x.obj"] }),
    good("x.ok2", { tier: "derived", formula: "sum(x_i * M_i) over CO2, N2, O2", depends_on: ["x.base"] }),
    good("x.bad", { tier: "derived", formula: "686.98 * 1361 / 1.5237^2", depends_on: ["x.base"] }),
    good("x.bad2", { tier: "modeled", formula: "x.base * 0.38", depends_on: ["x.base"] }),
  ]) });
  const r = validateFacts(dir);
  assert.ok(!r.errors.some(e => /x\.ok/.test(e)), r.errors.join("\n"));
  hasError(dir, /x\.bad: formula uses 1361, 1\.5237, which is not the value of any depends_on record/);
  hasError(dir, /x\.bad2: formula uses 0\.38/);
  assert.deepEqual(formulaLiterals("1361 / (1.5237*(1-0.0935))^2 + 2*pi + CO2 + 86400 + 1e3"), ["1361", "1.5237", "1", "0.0935", "2", "2", "pi", "86400", "1e3"]);
});

test("tier ordering: a record may not be stronger than its dependencies", () => {
  assert.deepEqual(TIER_ORDER, ["defined", "measured", "derived", "engineering", "modeled", "hypothesis"]);
  const dir = fixture({ "t.json": bundle([
    good("x.meas"),
    good("x.model", { tier: "modeled" }),
    good("x.hyp", { tier: "hypothesis" }),
    good("x.ok_derived", { tier: "derived", formula: "x.meas * 2", depends_on: ["x.meas"] }),
    good("x.ok_modeled", { tier: "modeled", formula: "x.model * 2", depends_on: ["x.model", "x.meas"] }),
    good("x.ok_eng", { tier: "engineering", depends_on: ["x.meas"] }),
    good("x.bad_derived", { tier: "derived", formula: "x.model * 2", depends_on: ["x.model"] }),
    good("x.bad_eng", { tier: "engineering", depends_on: ["x.hyp"] }),
    good("x.bad_measured", { depends_on: ["x.model"] }),
    good("x.ok_defined", { tier: "defined" }),
    good("x.bad_defined", { tier: "defined", depends_on: ["x.meas"] }),
  ]) });
  const r = validateFacts(dir);
  assert.ok(!r.errors.some(e => /x\.ok_/.test(e)), r.errors.join("\n"));
  hasError(dir, /x\.bad_derived: tier "derived" is stronger than its dependency x\.model \(modeled\)/);
  hasError(dir, /x\.bad_eng: tier "engineering" is stronger than its dependency x\.hyp \(hypothesis\)/);
  hasError(dir, /x\.bad_measured: tier "measured" is stronger than its dependency x\.model \(modeled\)/);
  hasError(dir, /x\.bad_defined: tier "defined" is stronger than its dependency x\.meas \(measured\)/);
});

test("warnings: APPROX records and uncited fact sources", () => {
  const dir = fixture({ "t.json": bundle([
    good("x.approx", { notes: "APPROX. Agent task F2." }),
  ]) });
  const r = validateFacts(dir);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some(w => /x\.approx: marked APPROX/.test(w)));
  assert.ok(r.warnings.some(w => /"meda-pds-archive" is not cited by any fact/.test(w)));
});

test("parseSources: headings, (R) section and Use: **R** lines", () => {
  const md = "# Sources\n\n## alpha-2020\nAlpha et al. (2020). Title. doi:10/x\nhttps://a.example/p (mirror: https://b.example/p)\nUse: **F** and **D** x. Verified 2026-01-02.\n\n## beta-2021\nUse: **R** reading only\n\n# Design references (R)\n\n## gamma-2009\nWhy it matters: ...\n";
  const s = parseSources(md);
  assert.deepEqual([...s.ids], ["alpha-2020", "beta-2021", "gamma-2009"]);
  assert.deepEqual([...s.referenceOnly], ["beta-2021", "gamma-2009"]);
  assert.deepEqual(s.entries.get("alpha-2020"), { citation: "Alpha et al. (2020). Title. doi:10/x", urls: ["https://a.example/p", "https://b.example/p"], use: ["F", "D"], verified: "2026-01-02" });
  assert.deepEqual(s.entries.get("gamma-2009").use, ["R"]);
  assert.equal(s.entries.get("gamma-2009").citation, "Why it matters: ...");
});

test("CLI: exit 1 on a bad record, exit 0 and writes index on good input, --check detects stale index", () => {
  const bad = fixture({ "t.json": bundle([good("x.bad", { source_ids: ["nope"] })]) });
  let r = spawnSync(process.execPath, [VALIDATE, "--dir", bad, "--quiet"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"nope" has no "## nope" heading/);

  const ok = fixture({ "t.json": bundle([good("x.ok")]) });
  r = spawnSync(process.execPath, [VALIDATE, "--dir", ok], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok: 1 package\(s\), 1 bundle\(s\), 1 fact\(s\), 0 error\(s\)/m);
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
