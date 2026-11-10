#!/usr/bin/env node
// ---------------------------------------------------------------------------
// facts/validate.mjs — validator and index builder for the Mars fact bundles.
//
//   node facts/validate.mjs                  validate facts/, write facts/index.json
//   node facts/validate.mjs --check          validate, and fail if index.json is stale
//   node facts/validate.mjs --dir A --dir B  validate package roots A and B together
//                                            (schema.json from A; index written to A)
//   node facts/validate.mjs --quiet          errors only
//
// A package root is a folder with the layout of facts/: one or more *.json
// bundles, a sources.md, and optionally a package.json whose "name" names the
// package (third-party contributions, see facts/README.md). The first root is
// the base package and must hold schema.json.
//
// Errors (any one fails the build, exit 1):
//   1. every bundle parses and validates against schema.json (ajv, 2020-12)
//   2. fact ids are unique across all bundles and packages
//   3. every source_ids entry resolves to a "## <id>" heading in a sources.md,
//      and is not a reference-only (R) design source
//   4. depends_on / superseded_by / competing_with resolve to existing ids;
//      no self-reference; no dependency cycle
//   5. derived records carry a non-empty formula and a non-empty depends_on
//   6. every numeric literal in a formula is the value of a depends_on record,
//      a small integer (0..10, exponents and coefficients), or one of the
//      explicit unit-conversion constants in ALLOWED_LITERALS. Anything else
//      is an unsourced number living inside facts/, which CLAUDE.md rules out.
//   7. a record never claims a stronger tier than any record it depends on
//      (TIER_ORDER below; composing with weaker evidence cannot raise a tier)
//
// Warnings (printed, never fatal):
//   - fact sources that nothing cites
//   - records still marked APPROX (open task F2)
//
// The index (facts/index.json) is deterministic: packages in the order given,
// bundles in filename order, facts in file order, no timestamps. content_hash
// is a sha256 over the canonical content so a world can pin exactly what it
// was created against. Shape: see buildIndex() and facts/README.md.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = "index.json";
const SCHEMA_FILE = "schema.json";
const SOURCES_FILE = "sources.md";
const LINK_FIELDS = ["depends_on", "superseded_by", "competing_with"];

/**
 * Provenance tiers, strongest first. A record may not claim a tier stronger
 * than any record in its depends_on. Rationale (facts/README.md): a design that
 * depends on a demonstrated technology is making an evidential claim too; a
 * flight demo is stronger than a lab trial but weaker than a measurement of
 * Mars itself. "defined" is for exact-by-convention values (the astronomical
 * unit) and outranks measurement because nothing can contradict a definition.
 * "assumption" is player-owned and never appears in facts/.
 */
export const TIER_ORDER = ["defined", "measured", "derived", "engineering", "modeled", "hypothesis"];
const tierRank = t => TIER_ORDER.indexOf(t);

/** Unit-conversion constants a formula may quote without a fact record. */
export const ALLOWED_LITERALS = new Set(["86400", "1000", "pi"]);
const SMALL_INTEGER_MAX = 10;

/**
 * Parse a sources.md into { ids, referenceOnly, entries }. entries maps id ->
 * { citation, urls, use, verified } taken from the heading's body: the first
 * non-empty line is the citation; every http(s) URL in the body; the bold
 * codes on a "Use:" line (F fact, D data, R reference); a "Verified YYYY-MM-DD".
 * Headings under an H1 containing "(R)", or with "Use: **R**", are reference-only.
 */
export function parseSources(markdown) {
  const ids = new Set();
  const referenceOnly = new Set();
  const entries = new Map();
  let inReferenceSection = false;
  let current = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1) { inReferenceSection = /\(R\)/.test(h1[1]); current = null; continue; }
    const h2 = /^##\s+(\S+)\s*$/.exec(line);
    if (h2) {
      current = h2[1];
      ids.add(current);
      entries.set(current, { citation: "", urls: [], use: inReferenceSection ? ["R"] : [], verified: null });
      if (inReferenceSection) referenceOnly.add(current);
      continue;
    }
    if (!current) continue;
    const entry = entries.get(current);
    if (line.trim() && !entry.citation) entry.citation = line.trim();
    for (const url of line.match(/https?:\/\/[^\s)]+/g) ?? []) if (!entry.urls.includes(url)) entry.urls.push(url);
    const use = /^Use:\s*(.*)$/.exec(line);
    if (use) {
      for (const code of use[1].match(/\*\*([A-Z])\*\*/g) ?? []) {
        const c = code.replace(/\*/g, "");
        if (!entry.use.includes(c)) entry.use.push(c);
      }
      if (/\*\*R\*\*/.test(use[1])) referenceOnly.add(current);
    }
    const verified = /Verified (\d{4}-\d{2}-\d{2})/.exec(line);
    if (verified) entry.verified = verified[1];
  }
  return { ids, referenceOnly, entries };
}

const loadJson = path => JSON.parse(readFileSync(path, "utf8"));

const listBundleFiles = dir => readdirSync(dir)
  .filter(f => f.endsWith(".json") && f !== SCHEMA_FILE && f !== INDEX_FILE && f !== "package.json")
  .sort();

function packageName(root) {
  const pj = join(root, "package.json");
  if (existsSync(pj)) { try { const n = loadJson(pj).name; if (typeof n === "string" && n) return n; } catch { /* reported below */ } }
  return basename(resolve(root));
}

/** Numbers a formula may quote: the values of its depends_on records (scalars, or numeric fields of object values). */
function dependsOnLiterals(fact, byId) {
  const out = new Set();
  for (const id of fact.depends_on ?? []) {
    const v = byId.get(id)?.record.value;
    if (typeof v === "number") out.add(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) if (typeof x === "number") out.add(x);
  }
  return out;
}

/** Numeric literals and the token "pi" in a formula; "CO2"-style tokens are not literals. */
export function formulaLiterals(formula) {
  return formula.match(/(?<![\w.])(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|pi)(?![\w])/gi) ?? [];
}

function strayLiterals(fact, byId) {
  const allowedValues = dependsOnLiterals(fact, byId);
  const stray = [];
  for (const lit of formulaLiterals(fact.formula ?? "")) {
    if (ALLOWED_LITERALS.has(lit.toLowerCase())) continue;
    const n = Number(lit);
    if (Number.isInteger(n) && n >= 0 && n <= SMALL_INTEGER_MAX) continue;
    if (allowedValues.has(n)) continue;
    if (!stray.includes(lit)) stray.push(lit);
  }
  return stray;
}

/**
 * Validate one or more package roots. Returns { ok, errors, warnings, index, bundles, roots }.
 * Throws only for a missing schema (first root) or a missing sources.md in any root.
 */
export function validateFacts(roots = HERE) {
  roots = (Array.isArray(roots) ? roots : [roots]).map(r => resolve(r));
  const errors = [];
  const warnings = [];
  const rel = p => relative(process.cwd(), p) || p;

  const schemaPath = join(roots[0], SCHEMA_FILE);
  if (!existsSync(schemaPath)) throw new Error(`missing ${schemaPath}`);
  for (const r of roots) if (!existsSync(join(r, SOURCES_FILE))) throw new Error(`missing ${join(r, SOURCES_FILE)}`);

  // strictRequired is off: ajv flags `required` inside if/then when the property is
  // declared on the parent schema (a known false positive). allowUnionTypes: the schema
  // deliberately lets `value` be number, string, array or object. Every other strict
  // check stays on.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  let validate;
  try {
    validate = ajv.compile(loadJson(schemaPath));
  } catch (e) {
    errors.push(`${rel(schemaPath)}: schema does not compile: ${e.message}`);
    return { ok: false, errors, warnings, index: null, bundles: [], roots };
  }

  // sources: union over roots
  const sources = { ids: new Set(), referenceOnly: new Set(), entries: new Map() };
  const packages = [];
  for (const root of roots) {
    const parsed = parseSources(readFileSync(join(root, SOURCES_FILE), "utf8"));
    for (const id of parsed.ids) { sources.ids.add(id); if (!sources.entries.has(id)) sources.entries.set(id, parsed.entries.get(id)); }
    for (const id of parsed.referenceOnly) sources.referenceOnly.add(id);
    packages.push({ name: packageName(root), root });
  }

  const bundles = [];
  const byId = new Map();          // id -> { record, bundle, file, package }
  const citedBy = new Map();       // source id -> [fact ids]

  // 1. parse + schema, 2. unique ids
  for (const pkg of packages) {
    for (const file of listBundleFiles(pkg.root)) {
      const path = join(pkg.root, file);
      let data;
      try { data = loadJson(path); }
      catch (e) { errors.push(`${rel(path)}: invalid JSON: ${e.message}`); continue; }
      if (!validate(data)) {
        for (const err of validate.errors) {
          if (err.keyword === "if") continue;   // "must match then schema": the real error is reported alongside
          const where = err.instancePath || "/";
          const m = /^\/facts\/(\d+)/.exec(where);
          const id = m && data.facts?.[+m[1]]?.id;
          const at = typeof id === "string" ? `${rel(path)}#${id}${where.slice(m[0].length)}` : `${rel(path)}${where}`;
          const extra = err.params?.additionalProperty ? ` (${err.params.additionalProperty})`
                      : err.params?.allowedValues ? ` (${err.params.allowedValues.join("|")})` : "";
          errors.push(`${at}: ${err.message}${extra}`);
        }
        continue;   // a bundle that fails the schema is not indexed
      }
      bundles.push({ file, path, data, package: pkg.name });
      data.facts.forEach((record, i) => {
        const prev = byId.get(record.id);
        if (prev) errors.push(`${rel(path)}/facts/${i}: duplicate id "${record.id}" (also in ${prev.file})`);
        else byId.set(record.id, { record, bundle: data.bundle, file, package: pkg.name });
      });
    }
  }

  // 3..7: cross-record checks
  for (const { record, file } of byId.values()) {
    const at = `${file}#${record.id}`;
    for (const sid of record.source_ids) {
      if (!sources.ids.has(sid)) errors.push(`${at}: source_ids "${sid}" has no "## ${sid}" heading in ${SOURCES_FILE}`);
      else if (sources.referenceOnly.has(sid)) errors.push(`${at}: source "${sid}" is a design/architecture reference (R), not a fact source`);
      else (citedBy.get(sid) ?? citedBy.set(sid, []).get(sid)).push(record.id);
    }
    for (const field of LINK_FIELDS) {
      const refs = Array.isArray(record[field]) ? record[field] : record[field] ? [record[field]] : [];
      for (const ref of refs) {
        if (ref === record.id) errors.push(`${at}: ${field} refers to itself`);
        else if (!byId.has(ref)) errors.push(`${at}: ${field} "${ref}" does not resolve to any fact id`);
      }
    }
    if (record.tier === "derived") {
      if (typeof record.formula !== "string" || !record.formula.trim()) errors.push(`${at}: derived record needs a non-empty formula`);
      if (!Array.isArray(record.depends_on) || record.depends_on.length === 0) errors.push(`${at}: derived record needs a non-empty depends_on`);
    }
    if (typeof record.formula === "string") {
      const stray = strayLiterals(record, byId);
      if (stray.length) errors.push(`${at}: formula uses ${stray.join(", ")}, which is not the value of any depends_on record and not an allowed unit conversion (${[...ALLOWED_LITERALS].join(", ")}); add a sourced record and reference it by id`);
    }
    for (const dep of record.depends_on ?? []) {
      const d = byId.get(dep)?.record;
      if (d && tierRank(record.tier) < tierRank(d.tier)) {
        errors.push(`${at}: tier "${record.tier}" is stronger than its dependency ${dep} (${d.tier}); composing with weaker evidence cannot raise a tier`);
      }
    }
    // APPROX marks a placeholder still awaiting replacement; a superseded record is history, not open work
    const text = `${record.notes ?? ""} ${record.uncertainty?.note ?? ""}`;
    if (!record.superseded_by && /\bapprox\b/i.test(text)) warnings.push(`${at}: marked APPROX (open task)`);
  }

  // 4b. dependency cycles (depends_on only)
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "active") { errors.push(`dependency cycle: ${[...stack, id].join(" -> ")}`); return; }
    state.set(id, "active");
    for (const dep of byId.get(id)?.record.depends_on ?? []) if (byId.has(dep)) visit(dep, [...stack, id]);
    state.set(id, "done");
  };
  for (const id of byId.keys()) visit(id, []);

  for (const sid of sources.ids) if (!sources.referenceOnly.has(sid) && !citedBy.has(sid)) warnings.push(`${SOURCES_FILE}: "${sid}" is not cited by any fact`);

  const index = buildIndex(packages, bundles, byId, sources, citedBy);
  return { ok: errors.length === 0, errors, warnings, index, bundles, roots };
}

/**
 * Index shape (documented in facts/README.md):
 *   content_hash  sha256 of the canonical content below (packages, bundles, ids, facts, sources)
 *   tier_order    TIER_ORDER, strongest first; clients rank by position
 *   packages      name -> { root, bundles[] }
 *   bundles       bundle name -> { file, package, version, description, fact_count }
 *   ids           every fact id, in index order (append-only for host keys, task H1)
 *   facts         id -> record fields + { bundle, package, tier_rank }
 *   sources       source id -> { citation, urls, use[], verified, reference_only, cited_by[] }
 */
function buildIndex(packages, bundles, byId, sources, citedBy) {
  const body = { packages: {}, bundles: {}, ids: [], facts: {}, sources: {} };
  // root is relative to the base package so the index does not depend on the cwd it was built from
  const base = packages[0].root;
  for (const p of packages) body.packages[p.name] = { root: relative(base, p.root) || ".", bundles: bundles.filter(b => b.package === p.name).map(b => b.data.bundle) };
  for (const { file, data, package: pkg } of bundles) {
    body.bundles[data.bundle] = { file, package: pkg, version: data.version, description: data.description ?? "", fact_count: data.facts.length };
  }
  for (const [id, { record, bundle, package: pkg }] of byId) {
    body.ids.push(id);
    body.facts[id] = { ...record, bundle, package: pkg, tier_rank: tierRank(record.tier) };
  }
  for (const sid of sources.ids) {
    const e = sources.entries.get(sid);
    body.sources[sid] = { ...e, reference_only: sources.referenceOnly.has(sid), cited_by: citedBy.get(sid) ?? [] };
  }
  const content_hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return {
    $comment: "Generated by facts/validate.mjs. Do not edit by hand; run `npm run facts`.",
    schema: SCHEMA_FILE,
    content_hash,
    tier_order: TIER_ORDER,
    ...body,
  };
}

export const renderIndex = index => JSON.stringify(index, null, 2) + "\n";

// ---- CLI -------------------------------------------------------------------
function main(argv) {
  const roots = [];
  let check = false, quiet = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") roots.push(argv[++i]);
    else if (argv[i] === "--check") check = true;
    else if (argv[i] === "--quiet") quiet = true;
    else { console.error(`unknown argument ${argv[i]}`); return 2; }
  }
  if (roots.length === 0) roots.push(HERE);

  const { ok, errors, warnings, index, bundles } = validateFacts(roots);
  const log = (...a) => { if (!quiet) console.log(...a); };
  for (const w of warnings) log(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);

  const indexPath = join(resolve(roots[0]), INDEX_FILE);
  if (ok) {
    const rendered = renderIndex(index);
    if (check) {
      const current = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
      if (current !== rendered) {
        console.error(`error: ${relative(process.cwd(), indexPath)} is stale; run \`npm run facts\` and commit the result`);
        return 1;
      }
    } else {
      writeFileSync(indexPath, rendered);
    }
  }
  const nFacts = bundles.reduce((n, b) => n + b.data.facts.length, 0);
  log(`${ok ? "ok" : "FAILED"}: ${roots.length} package(s), ${bundles.length} bundle(s), ${nFacts} fact(s), ${errors.length} error(s), ${warnings.length} warning(s)` +
      (ok && !check ? `; wrote ${relative(process.cwd(), indexPath)}` : ""));
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
