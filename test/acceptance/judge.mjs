// Judge recorded acceptance transcripts offline: rebuild the recorded source with the workshop's
// compile and smoke test, require the rebuilt bytes and the recorded bytes to both hash to the
// recorded sha256, load the REBUILT module through the registry and run the prompt's behaviour
// check, and recompute from the recorded turns whether a fact-grounded question came before the
// build. A transcript that is not consistent with itself cannot pass. Needs no network and no key.
//   node test/acceptance/judge.mjs                    every transcript under workshop/acceptance/
//   node test/acceptance/judge.mjs path/to/one.json
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileAndTest } from "../../workshop/compile.mts";
import { questionFactIds, otherFactIds } from "../../workshop/acceptance/run.mts";
import { CHECKS } from "./behaviour.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TRANSCRIPT_DIR = path.join(ROOT, "workshop", "acceptance");
const sha256 = b => createHash("sha256").update(b).digest("hex");

export function listTranscripts(dir = TRANSCRIPT_DIR) {
  return readdirSync(dir).filter(f => /^[1-5]-.*\.json$/.test(f)).sort().map(f => path.join(dir, f));
}

/** The agent's questions before the build, from the recorded turns (not from any flag in the transcript). */
export function questionsBeforeBuild(t) {
  const out = [];
  for (const turn of t.turns ?? []) {
    const a = turn?.answer;
    if (a?.type === "module") break;
    if (a?.type === "questions" && typeof a.text === "string") out.push(a.text);
  }
  return out;
}

/** @returns {{ file, prompt_number, result, verdict: "pass"|"fail"|"inconsistent"|"reviewer", why, ... }} */
export async function judgeTranscript(file) {
  const t = JSON.parse(readFileSync(file, "utf8"));
  const out = { file: path.basename(file), prompt_number: t.prompt_number, result: t.result ?? "(none)", tries: t.tries ?? null, system_sha256: t.system_sha256 };
  const qs = questionsBeforeBuild(t);
  out.question_fact_ids = [...new Set(qs.flatMap(questionFactIds))];
  out.question_other_ids = [...new Set(qs.flatMap(otherFactIds))];
  out.question_fact_grounded = out.question_fact_ids.length > 0;
  if (t.result !== "module" || typeof t.source !== "string") { out.verdict = "fail"; out.why = `no module in the transcript (${out.result})`; return out; }
  const built = await compileAndTest(t.source);
  out.rebuilt = built.ok; out.smoke = built.ok ? built.report : built.error;
  if (!built.ok) { out.verdict = "fail"; out.why = "the recorded source does not build and pass the smoke test today"; return out; }
  out.rebuilt_sha256 = sha256(built.wasm);
  out.recorded_sha256 = typeof t.wasm_base64 === "string" ? sha256(Buffer.from(t.wasm_base64, "base64")) : null;
  out.hash_match = out.rebuilt_sha256 === t.wasm_sha256 && out.recorded_sha256 === t.wasm_sha256;
  if (!out.hash_match) {
    out.verdict = "inconsistent";
    out.why = [out.rebuilt_sha256 !== t.wasm_sha256 ? "the source does not rebuild to the recorded sha256" : null, out.recorded_sha256 !== t.wasm_sha256 ? "the recorded bytes do not hash to the recorded sha256" : null].filter(Boolean).join("; ");
    return out;
  }
  const check = CHECKS[t.prompt_number];
  if (!check) { out.verdict = "fail"; out.why = `no behaviour check for prompt ${t.prompt_number}`; return out; }
  out.check = await check(built.wasm, t.manifest ?? null);                 // the rebuilt bytes, not the recorded ones
  const withinTries = Number.isInteger(t.tries) && t.tries <= 2;
  const problems = [out.check.pass ? null : "behaviour check failed", withinTries ? null : `took ${t.tries} tries (limit 2)`].filter(Boolean);
  if (!out.question_fact_grounded) problems.push(out.question_other_ids.length ? `id cited without brackets (${out.question_other_ids.join(", ")}): reviewer decides` : "no fact-grounded question before the build");
  out.verdict = problems.length === 0 ? "pass" : (!out.check.pass || !withinTries || !out.question_other_ids.length) ? "fail" : "reviewer";
  out.why = problems.join("; ") || "all conditions met";
  return out;
}

export async function judgeAll(dir = TRANSCRIPT_DIR) {
  const results = [];
  for (const f of listTranscripts(dir)) results.push(await judgeTranscript(f));
  return results;
}

/** Results grouped by system prompt hash, each group counted on its own. */
export function summarize(results) {
  const groups = new Map();
  for (const r of results) { const k = r.system_sha256 ?? "(no hash)"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  return [...groups.entries()].map(([hash, rs]) => ({ hash, total: rs.length, pass: rs.filter(r => r.verdict === "pass").length, reviewer: rs.filter(r => r.verdict === "reviewer").length, prompts: [...new Set(rs.map(r => r.prompt_number))].sort() }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const arg = process.argv[2];
  const results = arg ? [await judgeTranscript(path.resolve(arg))] : await judgeAll();
  if (!results.length) { console.log("judge: no transcripts under workshop/acceptance/ (the runs need an API key)"); process.exit(0); }
  for (const r of results) {
    console.log(`\n${r.file}: prompt ${r.prompt_number}, result ${r.result}, tries ${r.tries}, question ids ${r.question_fact_ids.join(", ") || "(none)"}${r.question_other_ids.length ? ` (without brackets: ${r.question_other_ids.join(", ")})` : ""}, system ${String(r.system_sha256).slice(0, 12)}`);
    if (r.smoke !== undefined) console.log(`  rebuild: ${r.rebuilt ? "ok" : "FAILED"}; rebuilt and recorded bytes both hash to the recorded sha256: ${r.hash_match}\n  smoke: ${String(r.smoke).split("\n")[0]}`);
    for (const e of r.check?.evidence ?? []) console.log(`  - ${e}`);
    console.log(`  verdict: ${r.verdict.toUpperCase()} (${r.why})`);
  }
  const groups = summarize(results);
  for (const g of groups) console.log(`\nsystem prompt ${g.hash.slice(0, 12)}: ${g.pass} of ${g.total} pass${g.reviewer ? `, ${g.reviewer} for the reviewer` : ""} (prompts ${g.prompts.join(", ")})`);
  if (groups.length > 1) console.log(`${groups.length} different system prompts in the folder: only one set counts as the final run`);
  process.exit(0);
}
