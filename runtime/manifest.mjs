// Dependency-free manifest check for the browser runtime. The JSON Schema in
// runtime/manifest.schema.json is the authority (the workshop server and the
// tests validate with ajv); this mirrors its rules so the page can refuse a bad
// manifest without a schema library. Returns a list of problems (empty = valid).
export const MAX_STATE_SLOTS = 16, MAX_SHAPES = 32, MAX_SIGNALS = 32, MAX_FACT_IDS = 64;
const ID_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const str = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;

export function validateManifest(m) {
  const errs = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["manifest must be an object"];
  const allowed = new Set(["name", "description", "version", "author", "state", "signals", "shapes", "fact_ids", "did_you_know"]);
  for (const k of Object.keys(m)) if (!allowed.has(k)) errs.push(`unknown field "${k}"`);
  if (!str(m.name, 64)) errs.push("name: string 1..64 chars");
  if (!str(m.description, 500)) errs.push("description: string 1..500 chars");
  if (!Number.isInteger(m.version) || m.version < 1) errs.push("version: integer >= 1");
  if (!str(m.author, 64)) errs.push("author: string 1..64 chars");
  if (m.state !== undefined) {
    if (!Array.isArray(m.state) || m.state.length > MAX_STATE_SLOTS) errs.push(`state: array of at most ${MAX_STATE_SLOTS}`);
    else m.state.forEach((s, i) => { if (!s || !Number.isInteger(s.slot) || s.slot < 0 || s.slot >= MAX_STATE_SLOTS || !str(s.label, 48) || (s.unit !== undefined && !(typeof s.unit === "string" && s.unit.length <= 16))) errs.push(`state[${i}]: {slot 0..15, label, unit?}`); });
  }
  if (m.signals !== undefined) {
    if (!m.signals || typeof m.signals !== "object") errs.push("signals: object");
    else for (const dir of ["emits", "listens"]) {
      const a = m.signals[dir]; if (a === undefined) continue;
      if (!Array.isArray(a) || a.length > MAX_SIGNALS) errs.push(`signals.${dir}: array of at most ${MAX_SIGNALS}`);
      else a.forEach((s, i) => { if (!s || !Number.isInteger(s.code) || s.code < 0 || s.code > 65535 || !str(s.label, 48)) errs.push(`signals.${dir}[${i}]: {code 0..65535, label, unit?}`); });
    }
    for (const k of Object.keys(m.signals ?? {})) if (k !== "emits" && k !== "listens") errs.push(`signals: unknown field "${k}"`);
  }
  if (m.shapes !== undefined && (!Number.isInteger(m.shapes) || m.shapes < 0 || m.shapes > MAX_SHAPES)) errs.push(`shapes: integer 0..${MAX_SHAPES}`);
  if (m.fact_ids !== undefined) {
    if (!Array.isArray(m.fact_ids) || m.fact_ids.length > MAX_FACT_IDS) errs.push(`fact_ids: array of at most ${MAX_FACT_IDS}`);
    else m.fact_ids.forEach((id, i) => { if (typeof id !== "string" || !ID_RE.test(id)) errs.push(`fact_ids[${i}]: dotted fact id`); });
  }
  if (m.did_you_know !== undefined && !(typeof m.did_you_know === "string" && m.did_you_know.length <= 300)) errs.push("did_you_know: string up to 300 chars");
  return errs;
}
