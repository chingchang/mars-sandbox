// The A1 acceptance runner: each prompt from a cold start (a freshly started workshop server and
// a new conversation) against the real model, the player's answers typed at the terminal (or read
// from an answers file), and the complete exchange recorded under workshop/acceptance/.
//
//   npm run acceptance -- --prompt 2            one prompt
//   npm run acceptance                          all five, in order
//   npm run acceptance -- --answers my.json     scripted player answers: { "2": ["first answer", ...], ... }
//
// Needs ANTHROPIC_API_KEY in the environment or in .env (the server reads it; this runner never
// sees it and records no headers). Every run is written, to a new file (never overwriting an
// earlier run) and even when the run throws: the messages as sent, every server answer
// (manifest, source, explanation, report, tries, the per-try log with each try's source and
// manifest, the module bytes and their sha256), the system prompt's hash and the model id from
// /health, the git commit, the fact ids cited in each question, and the numbers that appear
// without a fact id nearby. Nothing is edited after the fact. After a declined or failed
// answer the operator may send one more message in the same conversation, which is recorded
// as well (the issue's "does the declined turn matter?" question).
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUT_DIR = path.join(ROOT, "workshop", "acceptance");

/** The five prompts, from facts/AGENT_BRIEF.md, A1, verbatim. The acceptance list is not to be changed. */
export const ACCEPTANCE_PROMPTS = [
  "A weather station that logs temperature every hour and raises a red flag when it drops below minus 70.",
  "A beacon that lights up when any rover is within 20 metres.",
  "A solar panel that turns to track the sun and reports its output.",
  "A small creature that wanders around and hides behind rocks when the rover gets close.",
  "A dust gauge that estimates how dirty the panels are from the dust optical depth.",
];

const INDEX = JSON.parse(readFileSync(path.join(ROOT, "facts/index.json"), "utf8")) as { facts: Record<string, { superseded_by?: string }> };
const ID = "[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)+";
const live = (id: string) => !!INDEX.facts[id] && !INDEX.facts[id].superseded_by;

/** Fact ids cited as [id] in a question that resolve in the index (superseded ones do not count). */
export function questionFactIds(text: string): string[] {
  return [...new Set([...text.matchAll(new RegExp(`\\[(${ID})\\]`, "g"))].map(m => m[1]))].filter(live);
}
/** Ids written another way (backticks, parentheses, bare): recorded so punctuation alone cannot score a question as ungrounded. */
export function otherFactIds(text: string): string[] {
  const bracketed = new Set(questionFactIds(text));
  return [...new Set([...text.matchAll(new RegExp(`(?<![\\[a-z0-9_.])(${ID})(?![\\]a-z0-9_.])`, "g"))].map(m => m[1]))].filter(id => live(id) && !bracketed.has(id));
}

const UNIT = "(?:°\\s?C|º\\s?C|degrees?(?:\\s+(?:celsius|c|kelvin|k))?|K\\b|C\\b|kelvin|celsius|W\\s?\\/\\s?m\\s?\\^?\\s?2|watts?(?:\\s+per\\s+square\\s+met(?:er|re))?|W\\b|mbar|millibars?|hPa|kPa|Pa\\b|pascals?|mSv|km\\b|kilomet(?:er|re)s?|m\\/s\\^?2|m\\/s\\b|met(?:er|re)s?\\s+per\\s+second|sols?\\b|days?\\b|hours?\\b|h\\b|minutes?\\b|min\\b|seconds?\\b|s\\b|%|percent|g\\b)";
const NUMBER = `(?:(?:minus|−|-)\\s?)?\\d+(?:[.,]\\d+)?`;
/**
 * Numbers with a Mars-looking unit that are not followed, before the sentence ends and before any other
 * such number, by a [fact.id] (the way the agent is told to cite: the number, then its id). A cited id
 * covers only the number it follows. For the reviewer, not a verdict: every transcript is read in full.
 */
export function numbersWithoutFacts(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(${NUMBER})\\s?(${UNIT})`, "gi");
  const matches = [...text.matchAll(re)];
  matches.forEach((m, i) => {
    const start = m.index! + m[0].length;
    let end = text.length;
    const stop = text.slice(start).search(/[.!?]\s|\n/); if (stop >= 0) end = Math.min(end, start + stop + 1);
    const next = matches[i + 1]; if (next) end = Math.min(end, next.index!);
    if (new RegExp(`\\[${ID}\\]`).test(text.slice(start, end))) return;
    out.push(`${m[1]} ${m[2]}`.replace(/\s+/g, " "));
  });
  return out;
}
/** Every text in a transcript the prompt's rule covers: questions, explanation, manifest text, source comments. */
export function unsourcedNumbersIn(t: { questions?: { text: string }[]; explanation?: string; manifest?: Record<string, unknown>; source?: string }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (k: string, s: unknown) => { if (typeof s === "string") { const n = numbersWithoutFacts(s); if (n.length) out[k] = n; } };
  (t.questions ?? []).forEach((q, i) => add(`question ${i + 1}`, q.text));
  add("explanation", t.explanation);
  const m = t.manifest as { description?: string; state?: { label?: string }[]; did_you_know?: { text?: string } } | undefined;
  if (m) { add("manifest.description", m.description); (m.state ?? []).forEach((s, i) => add(`manifest.state[${i}].label`, s.label)); if (!(m.did_you_know as { fact_id?: string } | undefined)?.fact_id) add("manifest.did_you_know", m.did_you_know?.text); }   // did_you_know is tied to its fact_id field
  if (typeof t.source === "string") add("source comments", [...t.source.matchAll(/\/\/(.*)$|\/\*([\s\S]*?)\*\//gm)].map(x => x[1] ?? x[2] ?? "").join("\n"));
  return out;
}

export function transcriptName(n: number, prompt: string, stamp = new Date()): string {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 9).join("-");
  return `${n}-${slug}-${stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`;
}

export type Health = { ok: boolean; model: string; facts: number; system_bytes: number; system_sha256: string };
export type Answer = Record<string, unknown> & { type?: string; error?: unknown };
export type Server = { url: string; health: Health; stop: () => void };

/** The real thing: workshop/server.mts as a child process on a random port, so the prompt is rebuilt from the files. */
export async function startChildServer(): Promise<Server> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, "workshop/server.mts")], { env: { ...process.env, WORKSHOP_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let err = ""; child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`the workshop server stopped: ${err.trim()}`);
    try { const r = await fetch(url + "/health"); if (r.ok) return { url, health: await r.json() as Health, stop: () => { child.kill(); } }; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill(); throw new Error("the workshop server did not come up in 10 s: " + err.trim());
}

async function ask(url: string, messages: { role: string; content: string }[]): Promise<{ status: number; body: Answer }> {
  const r = await fetch(url + "/workshop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) });
  let body: Answer; try { body = await r.json() as Answer; } catch { body = { type: "unparseable" }; }
  return { status: r.status, body };
}

function gitState() {
  try { return { git_head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), git_clean: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() === "" }; }
  catch { return { git_head: null, git_clean: null }; }
}

export type RunOptions = { answers?: string[]; readline?: ReturnType<typeof createInterface> | null; startServer?: () => Promise<Server>; outDir?: string; quiet?: boolean };

export async function runPrompt(n: number, { answers = [], readline = null, startServer = startChildServer, outDir = OUT_DIR, quiet = false }: RunOptions = {}) {
  const prompt = ACCEPTANCE_PROMPTS[n - 1];
  if (!prompt) throw new Error(`no prompt ${n}`);
  const say = (s: string) => { if (!quiet) console.log(s); };
  const transcript: Record<string, unknown> = { prompt_number: n, prompt, started: new Date().toISOString(), ...gitState(), turns: [] as unknown[], questions: [] as unknown[] };
  const turns = transcript.turns as unknown[], questions = transcript.questions as unknown[];
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: prompt }];
  const nextAnswer = async (what: string): Promise<string | null> => {
    const scripted = answers.shift();
    if (scripted !== undefined) { say(`you (scripted): ${scripted}`); return scripted; }
    if (!readline) return null;
    const typed = (await readline.question(`${what}: `)).trim();
    return typed || null;
  };
  let server: Server | null = null;
  try {
    server = await startServer();                                      // cold start: a fresh server and a fresh conversation
    Object.assign(transcript, { model: server.health.model, system_sha256: server.health.system_sha256, system_bytes: server.health.system_bytes, facts_in_prompt: server.health.facts });
    say(`\n=== prompt ${n}: ${prompt}\n    model ${server.health.model}, system prompt sha256 ${String(server.health.system_sha256).slice(0, 12)}…`);
    let afterFailure = false;
    for (let round = 0; round < 10; round++) {
      const { status, body } = await ask(server.url, messages);
      turns.push({ request_messages: messages.map(m => ({ ...m })), status, answer: body, at: new Date().toISOString(), after_failure: afterFailure });
      if (afterFailure) { Object.assign(transcript, { after_failure_turn: { status, type: body.type, kept_declined_turn_in_history: true } }); say(`\nafter the failure: ${body.type} (${status})`); break; }
      if (body.type === "questions") {
        const text = String(body.text);
        const ids = questionFactIds(text), other = otherFactIds(text);
        questions.push({ text, fact_ids: ids, fact_ids_other_punctuation: other, numbers_without_facts: numbersWithoutFacts(text) });
        say(`\nagent: ${text}\n    fact ids cited: ${ids.join(", ") || "(none)"}${other.length ? ` (also, not in brackets: ${other.join(", ")})` : ""}`);
        const answer = await nextAnswer("you");
        if (answer === null) throw new Error("the agent asked a question and no answer is available (scripted answers exhausted and no terminal)");
        messages.push({ role: "assistant", content: text }, { role: "user", content: answer });
        continue;
      }
      if (body.type === "module") {
        const wasm = Buffer.from(String(body.wasm), "base64");
        Object.assign(transcript, { result: "module", name: body.name, tries: body.tries, report: body.report, manifest: body.manifest, source: body.source, explanation: body.explanation, fact_ids: body.fact_ids, log: body.log,
          wasm_sha256: createHash("sha256").update(wasm).digest("hex"), wasm_base64: body.wasm });
        say(`\nbuilt "${body.name}" in ${body.tries} tr${body.tries === 1 ? "y" : "ies"}: ${body.report}`);
        break;
      }
      Object.assign(transcript, { result: body.type === "failed" ? "failed" : `error ${status}`, error: body.error ?? body.type, tries: body.tries, log: body.log });
      say(`\n${transcript.result}: ${JSON.stringify(transcript.error)}`);
      // the issue's question: does the declined or failed turn, kept in the history, hurt the next one? Send one more message if the operator wants to.
      const more = await nextAnswer("one more message in the same conversation (empty to stop)");
      if (more === null) break;
      if (body.type === "failed") messages.push({ role: "assistant", content: "(the build did not pass its tests: " + String(body.error ?? "").split("\n")[0] + ")" });
      messages.push({ role: "user", content: more });
      afterFailure = true;
    }
  } catch (e) {
    transcript.error = transcript.error ?? (e instanceof Error ? e.message : String(e)); transcript.result = transcript.result ?? "runner error";
    say(`\nrunner error: ${transcript.error}`);
  } finally {
    server?.stop();
    transcript.finished = new Date().toISOString();
    transcript.question_asked_before_build = questions.length > 0;
    transcript.question_fact_grounded = questions.some(q => (q as { fact_ids: string[] }).fact_ids.length > 0);
    transcript.numbers_without_facts = unsourcedNumbersIn(transcript as Parameters<typeof unsourcedNumbersIn>[0]);
    mkdirSync(outDir, { recursive: true });
    let file = path.join(outDir, transcriptName(n, prompt));
    for (let k = 2; existsSync(file); k++) file = file.replace(/(-\d+)?\.json$/, `-${k}.json`);   // never overwrite an earlier run
    writeFileSync(file, JSON.stringify(transcript, null, 1) + "\n");
    transcript.file = file;
    say(`recorded ${path.relative(ROOT, file)}`);
  }
  return transcript;
}

async function main() {
  const args = process.argv.slice(2);
  const which = args.includes("--prompt") ? [Number(args[args.indexOf("--prompt") + 1])] : [1, 2, 3, 4, 5];
  const answersFile = args.includes("--answers") ? args[args.indexOf("--answers") + 1] : null;
  const scripted: Record<string, string[]> = answersFile ? JSON.parse(readFileSync(answersFile, "utf8")) : {};
  if (!process.env.ANTHROPIC_API_KEY && !existsSync(path.join(ROOT, ".env"))) { console.error("acceptance: no ANTHROPIC_API_KEY in the environment and no .env; the server cannot start"); process.exit(2); }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try { for (const n of which) await runPrompt(n, { answers: [...(scripted[String(n)] ?? [])], readline }); }
  finally { readline.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(e => { console.error(e); process.exit(1); });
