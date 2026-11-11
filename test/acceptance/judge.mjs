// Judge recorded acceptance transcripts offline: rebuild the recorded source with the workshop's
// compile and smoke test, compare the hash with the recorded module, load it through the registry
// and run the prompt's behaviour check. Prints the evidence. Needs no network and no key.
//   node test/acceptance/judge.mjs                    every transcript under workshop/acceptance/
//   node test/acceptance/judge.mjs path/to/one.json
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileAndTest } from "../../workshop/compile.mts";
import { CHECKS } from "./behaviour.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TRANSCRIPT_DIR = path.join(ROOT, "workshop", "acceptance");

export function listTranscripts(dir = TRANSCRIPT_DIR) {
  return readdirSync(dir).filter(f => /^[1-5]-.*\.json$/.test(f)).sort().map(f => path.join(dir, f));
}

/** @returns {{ file, prompt_number, result, rebuilt, hash_match, smoke, check, verdict }} */
export async function judgeTranscript(file) {
  const t = JSON.parse(readFileSync(file, "utf8"));
  const out = { file: path.basename(file), prompt_number: t.prompt_number, result: t.result ?? "(none)", tries: t.tries ?? null, question_fact_grounded: !!t.question_fact_grounded, system_sha256: t.system_sha256 };
  if (t.result !== "module" || typeof t.source !== "string") { out.verdict = "fail"; out.why = `no module in the transcript (${out.result})`; return out; }
  const built = await compileAndTest(t.source);
  out.rebuilt = built.ok; out.smoke = built.ok ? built.report : built.error;
  if (!built.ok) { out.verdict = "fail"; out.why = "the recorded source does not build and pass the smoke test today"; return out; }
  out.hash_match = createHash("sha256").update(built.wasm).digest("hex") === t.wasm_sha256;
  const check = CHECKS[t.prompt_number];
  if (!check) { out.verdict = "fail"; out.why = `no behaviour check for prompt ${t.prompt_number}`; return out; }
  out.check = await check(Buffer.from(t.wasm_base64, "base64"), t.manifest ?? null);
  const withinTries = Number.isInteger(t.tries) && t.tries <= 2;
  out.verdict = out.check.pass && withinTries && out.question_fact_grounded ? "pass" : "fail";
  out.why = [out.check.pass ? null : "behaviour check failed", withinTries ? null : `took ${t.tries} tries (limit 2)`, out.question_fact_grounded ? null : "no fact-grounded question before the build"].filter(Boolean).join("; ") || "all conditions met";
  return out;
}

export async function judgeAll(dir = TRANSCRIPT_DIR) {
  const files = listTranscripts(dir);
  const results = [];
  for (const f of files) results.push(await judgeTranscript(f));
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const arg = process.argv[2];
  const results = arg ? [await judgeTranscript(path.resolve(arg))] : await judgeAll();
  if (!results.length) { console.log("judge: no transcripts under workshop/acceptance/ (the runs need an API key)"); process.exit(0); }
  for (const r of results) {
    console.log(`\n${r.file}: prompt ${r.prompt_number}, result ${r.result}, tries ${r.tries}, fact-grounded question ${r.question_fact_grounded}, system ${String(r.system_sha256).slice(0, 12)}`);
    if (r.smoke !== undefined) console.log(`  rebuild: ${r.rebuilt ? "ok" : "FAILED"}; hash matches the recorded module: ${r.hash_match}\n  smoke: ${String(r.smoke).split("\n")[0]}`);
    for (const e of r.check?.evidence ?? []) console.log(`  - ${e}`);
    console.log(`  verdict: ${r.verdict.toUpperCase()} (${r.why})`);
  }
  const fails = results.filter(r => r.verdict !== "pass").length;
  console.log(`\n${results.length - fails} of ${results.length} pass`);
  process.exit(0);
}
