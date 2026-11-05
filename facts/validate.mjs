#!/usr/bin/env node
// ---------------------------------------------------------------------------
// facts/validate.mjs — validator and index builder for the Mars fact bundles.
//
//   node facts/validate.mjs            validate every bundle, write facts/index.json
//   node facts/validate.mjs --check    validate, and fail if index.json is stale
//   node facts/validate.mjs --dir D    operate on another facts folder (tests)
//   node facts/validate.mjs --quiet    errors only
//
// Checks (any error fails the build, exit code 1):
//   1. every facts/*.json (except schema.json, index.json) parses and validates
//      against schema.json (ajv, JSON Schema 2020-12)
//   2. fact ids are unique across all bundles
//   3. every source_ids entry resolves to a "## <id>" heading in sources.md,
//      and is not a reference-only (R) design source
//   4. every depends_on / superseded_by / competing_with entry resolves to an
//      existing fact id; no self-dependency; no dependency cycles
//   5. derived records carry a non-empty formula and a non-empty depends_on
//
// Warnings (printed, never fatal):
//   - fact sources that nothing cites
//   - records still marked APPROX (open task F2)
//   - numeric literals in a derived formula that are not the value of any
//     depends_on record (the reviewer recomputes derived values; this flags
//     numbers that entered a formula without a traceable record)
//
// The index (facts/index.json) is a flat id -> record map plus bundle versions.
// It is deterministic: bundles in filename order, facts in file order, no
// timestamps, so the engine and task H1 can rely on stable ordering.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = "index.json";
const SCHEMA_FILE = "schema.json";
const SOURCES_FILE = "sources.md";
const LINK_FIELDS = ["depends_on", "superseded_by", "competing_with"];

/** Parse sources.md into the set of citable ids and the set of reference-only ids. */
export function parseSources(markdown) {
  const ids = new Set();
  const referenceOnly = new Set();
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
      if (inReferenceSection) referenceOnly.add(current);
      continue;
    }
    // A "Use: **R**" line also marks a heading as reference-only.
    if (current && /^Use:\s*\*\*R\*\*/.test(line)) referenceOnly.add(current);
  }
  return { ids, referenceOnly };
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listBundleFiles(dir) {
  return readdirSync(dir)
    .filter(f => f.endsWith(".json") && f !== SCHEMA_FILE && f !== INDEX_FILE)
    .sort();
}

/** Values a derived formula may legitimately quote: the values of its depends_on records. */
function dependsOnLiterals(fact, byId) {
  const out = new Set();
  for (const id of fact.depends_on ?? []) {
    const v = byId.get(id)?.record.value;
    if (typeof v === "number") out.add(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) if (typeof x === "number") out.add(x);
  }
  return out;
}

function formulaLiterals(formula) {
  return (formula.match(/(?<![\w.])\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? []).map(Number);
}

/**
 * Validate the bundles in `dir`. Returns { ok, errors, warnings, index, bundles }.
 * Never throws for content problems; only for a missing schema or sources file.
 */
export function validateFacts(dir = HERE) {
  const errors = [];
  const warnings = [];
  const rel = p => relative(process.cwd(), p) || p;

  const schemaPath = join(dir, SCHEMA_FILE);
  const sourcesPath = join(dir, SOURCES_FILE);
  if (!existsSync(schemaPath)) throw new Error(`missing ${schemaPath}`);
  if (!existsSync(sourcesPath)) throw new Error(`missing ${sourcesPath}`);

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
    return { ok: false, errors, warnings, index: null, bundles: [] };
  }

  const sources = parseSources(readFileSync(sourcesPath, "utf8"));
  const bundles = [];
  const byId = new Map();          // id -> { record, bundle, file }
  const citedBy = new Map();       // source id -> [fact ids]

  // 1. parse + schema
  for (const file of listBundleFiles(dir)) {
    const path = join(dir, file);
    let data;
    try { data = loadJson(path); }
    catch (e) { errors.push(`${rel(path)}: invalid JSON: ${e.message}`); continue; }
    if (!validate(data)) {
      for (const err of validate.errors) {
        if (err.keyword === "if") continue;   // "must match then schema": the real error is reported alongside
        const where = err.instancePath || "/";
        // Name the record by id when the error is inside a fact, e.g. "jezero.json#jezero.x.y/unit"
        const m = /^\/facts\/(\d+)/.exec(where);
        const id = m && data.facts?.[+m[1]]?.id;
        const at = typeof id === "string" ? `${rel(path)}#${id}${where.slice(m[0].length)}` : `${rel(path)}${where}`;
        const extra = err.params?.additionalProperty ? ` (${err.params.additionalProperty})`
                    : err.params?.allowedValues ? ` (${err.params.allowedValues.join("|")})` : "";
        errors.push(`${at}: ${err.message}${extra}`);
      }
      continue;   // a bundle that fails the schema is not indexed
    }
    bundles.push({ file, path, data });
    // 2. unique ids
    data.facts.forEach((record, i) => {
      const prev = byId.get(record.id);
      if (prev) errors.push(`${rel(path)}/facts/${i}: duplicate id "${record.id}" (also in ${prev.file})`);
      else byId.set(record.id, { record, bundle: data.bundle, file });
    });
  }

  // 3, 4, 5: cross-record checks on every indexed record
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
      else {
        const allowed = dependsOnLiterals(record, byId);
        const stray = formulaLiterals(record.formula ?? "").filter(n => n > 10 && !allowed.has(n));
        if (stray.length) warnings.push(`${at}: formula uses ${[...new Set(stray)].join(", ")} which is not the value of any depends_on record`);
      }
    }
    const text = `${record.notes ?? ""} ${record.uncertainty?.note ?? ""}`;
    if (/\bapprox\b/i.test(text)) warnings.push(`${at}: marked APPROX (task F2)`);
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

  // warnings: uncited fact sources
  for (const sid of sources.ids) if (!sources.referenceOnly.has(sid) && !citedBy.has(sid)) warnings.push(`${SOURCES_FILE}: "${sid}" is not cited by any fact`);

  const index = buildIndex(bundles, byId, sources, citedBy);
  return { ok: errors.length === 0, errors, warnings, index, bundles };
}

function buildIndex(bundles, byId, sources, citedBy) {
  const index = {
    $comment: "Generated by facts/validate.mjs. Do not edit by hand; run `npm run facts`.",
    schema: SCHEMA_FILE,
    bundles: {},
    ids: [],
    facts: {},
    sources: {},
  };
  for (const { file, data } of bundles) {
    index.bundles[data.bundle] = { file, version: data.version, description: data.description ?? "", fact_count: data.facts.length };
  }
  for (const [id, { record, bundle }] of byId) {
    index.ids.push(id);
    index.facts[id] = { ...record, bundle };
  }
  for (const sid of [...sources.ids]) {
    index.sources[sid] = { reference_only: sources.referenceOnly.has(sid), cited_by: citedBy.get(sid) ?? [] };
  }
  return index;
}

export function renderIndex(index) {
  return JSON.stringify(index, null, 2) + "\n";
}

// ---- CLI -------------------------------------------------------------------
function main(argv) {
  const args = new Set(argv);
  const dirFlag = argv.indexOf("--dir");
  const dir = dirFlag >= 0 ? argv[dirFlag + 1] : HERE;
  const check = args.has("--check");
  const quiet = args.has("--quiet");

  const { ok, errors, warnings, index, bundles } = validateFacts(dir);
  const log = (...a) => { if (!quiet) console.log(...a); };

  for (const w of warnings) log(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);

  const indexPath = join(dir, INDEX_FILE);
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
  log(`${ok ? "ok" : "FAILED"}: ${bundles.length} bundle(s), ${nFacts} fact(s), ${errors.length} error(s), ${warnings.length} warning(s)` +
      (ok && !check ? `; wrote ${relative(process.cwd(), indexPath)}` : ""));
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
