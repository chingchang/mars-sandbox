#!/usr/bin/env node
// ---------------------------------------------------------------------------
// facts/derive/recompute.mjs — recompute every `derived` record from its
// depends_on using its stated formula, and fail if the stored value disagrees.
//
//   node facts/derive/recompute.mjs            (also run by `npm run facts:check`)
//
// A formula is an arithmetic expression over fact ids (dot-separated), numeric
// literals, the unit-conversion constants the validator allows (86400, 1000,
// pi), the operators + - * / ^ and parentheses, and the functions sqrt, exp,
// log, sin, cos. Anything else makes the formula "not evaluable", which is an
// error unless the id is listed in NOT_EVALUABLE with a reason.
//
// Agreement: |recomputed - stored| must be within the record's uncertainty
// (plus_minus value, or half the range width) or, if that is smaller, half a
// unit in the last place of the stored value. Values are compared in the
// record's own unit, so a formula must yield the unit the record states.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, "..", "index.json");

/** Derived records whose formula is prose and cannot be evaluated here, with the reason. */
export const NOT_EVALUABLE = {
  "jezero.subsurface.thermal_stability_depth":
    "needs regolith density and heat capacity, which are not facts; task P1 computes it in sim/primitives and this record should then be re-derived or demoted",
};

const FUNCS = { sqrt: Math.sqrt, exp: Math.exp, log: Math.log, sin: Math.sin, cos: Math.cos };
const CONSTS = { pi: Math.PI };

/** Tokenise and translate a formula into a JS expression over a values map, or return null if not an expression. */
export function compileFormula(formula, byId) {
  const tokens = formula.match(/[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+|[a-z]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?|[-+*/^()]/gi);
  if (!tokens || tokens.join("").replace(/\s/g, "") !== formula.replace(/\s/g, "")) return null;
  const js = [];
  for (const t of tokens) {
    if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(t)) { if (!(t in byId)) return null; js.push(`v[${JSON.stringify(t)}]`); }
    else if (/^[a-z]+$/i.test(t)) { if (t in FUNCS) js.push(`f.${t}`); else if (t in CONSTS) js.push(`c.${t}`); else return null; }
    else if (t === "^") js.push("**");
    else js.push(t);
  }
  return js.join(" ");
}

function tolerance(record) {
  const u = record.uncertainty ?? {};
  let tol = 0;
  if (u.type === "plus_minus" && typeof u.value === "number") tol = u.value;
  else if (u.type === "range" && typeof u.low === "number" && typeof u.high === "number") tol = (u.high - u.low) / 2;
  else if (u.type === "relative" && typeof u.value === "number") tol = Math.abs(record.value) * u.value;
  // half a unit in the last place of the stored value, as written in the bundle
  const s = String(record.value); const m = /\.(\d+)$/.exec(s); const ulp = m ? 0.5 * 10 ** -m[1].length : 0.5;
  return Math.max(tol, ulp);
}

export function recompute(index) {
  const byId = index.facts;
  const values = Object.fromEntries(Object.entries(byId).map(([id, r]) => [id, r.value]));
  const results = [];
  for (const [id, r] of Object.entries(byId)) {
    if (r.tier !== "derived") continue;
    const js = compileFormula(r.formula, byId);
    if (js === null) {
      results.push({ id, status: id in NOT_EVALUABLE ? "skipped" : "error", message: id in NOT_EVALUABLE ? NOT_EVALUABLE[id] : `formula is not an evaluable expression: ${r.formula}` });
      continue;
    }
    for (const dep of r.depends_on) if (typeof values[dep] !== "number") { results.push({ id, status: "error", message: `depends_on ${dep} has a non-numeric value` }); }
    let got;
    try { got = Function("v", "f", "c", `"use strict"; return (${js});`)(values, FUNCS, CONSTS); }
    catch (e) { results.push({ id, status: "error", message: `evaluation failed: ${e.message}` }); continue; }
    const tol = tolerance(r), diff = Math.abs(got - r.value);
    results.push({ id, status: diff <= tol ? "ok" : "error", recomputed: got, stored: r.value, tolerance: tol,
                   message: diff <= tol ? `${got} vs stored ${r.value} (tol ${tol})` : `recomputed ${got}, stored ${r.value}, differs by ${diff} > tolerance ${tol}` });
  }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = recompute(JSON.parse(readFileSync(INDEX, "utf8")));
  let errors = 0;
  for (const r of results) {
    if (r.status === "error") { errors++; console.error(`error: ${r.id}: ${r.message}`); }
    else if (r.status === "skipped") console.log(`warning: ${r.id}: not recomputed; ${r.message}`);
    else console.log(`ok: ${r.id}: ${r.message}`);
  }
  console.log(`${errors ? "FAILED" : "ok"}: ${results.length} derived record(s), ${errors} error(s)`);
  process.exit(errors ? 1 : 0);
}
