// The A1 acceptance runner: each prompt from a cold start (a freshly started workshop server and
// a new conversation) against the real model, the player's answers typed at the terminal (or read
// from an answers file), and the complete exchange recorded under workshop/acceptance/.
//
//   npm run acceptance -- --prompt 2            one prompt
//   npm run acceptance                          all five, in order
//   npm run acceptance -- --answers my.json     scripted player answers: { "2": ["first answer", ...], ... }
//
// Needs ANTHROPIC_API_KEY in the environment or in .env (the server reads it; this runner never
// sees it and records no headers). The transcripts hold the messages as sent, every server answer
// (manifest, source, explanation, report, tries, per-try log, the module bytes), the system
// prompt's hash and the model id from /health, and the checks below. Nothing is edited.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

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

/** Fact ids cited as [id] in a question that resolve in the index (superseded ones do not count). */
export function questionFactIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\[([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\]/g)].map(m => m[1]))].filter(id => INDEX.facts[id] && !INDEX.facts[id].superseded_by);
}

/** Numbers with a Mars-looking unit in a sentence that cites no fact id: for the reviewer, not a verdict. */
export function numbersWithoutFacts(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (/\[[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+\]/.test(sentence)) continue;
    for (const m of sentence.matchAll(/(-?\d+(?:\.\d+)?)\s?(K|°C|C\b|W\/m\^?2|W|mbar|Pa|hPa|kPa|mSv|km|sols?\b|m\/s|g\b)/g)) out.push(`${m[1]} ${m[2]}`);
  }
  return out;
}

export function transcriptName(n: number, prompt: string): string {
  return `${n}-${prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 9).join("-")}.json`;
}

type Health = { ok: boolean; model: string; facts: number; system_bytes: number; system_sha256: string };
type Answer = Record<string, unknown> & { type: string };

async function startServer(): Promise<{ url: string; health: Health; stop: () => void }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, "workshop/server.mts")], { env: { ...process.env, WORKSHOP_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let err = ""; child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`the workshop server stopped: ${err.trim()}`);
    try { const r = await fetch(url + "/health"); if (r.ok) return { url, health: await r.json() as Health, stop: () => child.kill() }; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill(); throw new Error("the workshop server did not come up in 10 s: " + err.trim());
}

async function ask(url: string, messages: { role: string; content: string }[]): Promise<{ status: number; body: Answer }> {
  const r = await fetch(url + "/workshop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) });
  return { status: r.status, body: await r.json() as Answer };
}

export async function runPrompt(n: number, { answers = [], readline = null }: { answers?: string[]; readline?: ReturnType<typeof createInterface> | null } = {}) {
  const prompt = ACCEPTANCE_PROMPTS[n - 1];
  if (!prompt) throw new Error(`no prompt ${n}`);
  const { url, health, stop } = await startServer();                   // cold start: a fresh server and a fresh conversation
  const transcript: Record<string, unknown> = { prompt_number: n, prompt, started: new Date().toISOString(), model: health.model, system_sha256: health.system_sha256, system_bytes: health.system_bytes, facts_in_prompt: health.facts, turns: [] as unknown[], questions: [] as unknown[] };
  const turns = transcript.turns as unknown[], questions = transcript.questions as unknown[];
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: prompt }];
  console.log(`\n=== prompt ${n}: ${prompt}\n    model ${health.model}, system prompt sha256 ${health.system_sha256.slice(0, 12)}…`);
  try {
    for (let round = 0; round < 8; round++) {
      const { status, body } = await ask(url, messages);
      turns.push({ request_messages: messages.map(m => ({ ...m })), status, answer: body, at: new Date().toISOString() });
      if (body.type === "questions") {
        const text = String(body.text);
        const ids = questionFactIds(text);
        questions.push({ text, fact_ids: ids, numbers_without_facts: numbersWithoutFacts(text) });
        console.log(`\nagent: ${text}\n    fact ids cited: ${ids.join(", ") || "(none)"}`);
        let answer = answers.shift();
        if (answer === undefined) { if (!readline) throw new Error("the agent asked a question and no answer is scripted; run without --answers to answer at the terminal"); answer = (await readline.question("you: ")).trim(); }
        else console.log(`you (scripted): ${answer}`);
        messages.push({ role: "assistant", content: text }, { role: "user", content: answer });
        continue;
      }
      if (body.type === "module") {
        const wasm = Buffer.from(String(body.wasm), "base64");
        Object.assign(transcript, { result: "module", name: body.name, tries: body.tries, report: body.report, manifest: body.manifest, source: body.source, explanation: body.explanation, fact_ids: body.fact_ids, log: body.log,
          wasm_sha256: createHash("sha256").update(wasm).digest("hex"), wasm_base64: body.wasm, explanation_numbers_without_facts: numbersWithoutFacts(String(body.explanation ?? "")) });
        console.log(`\nbuilt "${body.name}" in ${body.tries} tr${body.tries === 1 ? "y" : "ies"}: ${body.report}`);
        break;
      }
      Object.assign(transcript, { result: body.type === "failed" ? "failed" : `error ${status}`, error: body.error ?? body.type, tries: body.tries, log: body.log });
      console.log(`\n${transcript.result}: ${transcript.error}`);
      break;
    }
  } finally { stop(); }
  transcript.finished = new Date().toISOString();
  transcript.question_asked_before_build = questions.length > 0;
  transcript.question_fact_grounded = questions.some(q => (q as { fact_ids: string[] }).fact_ids.length > 0);
  mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, transcriptName(n, prompt));
  writeFileSync(file, JSON.stringify(transcript, null, 1) + "\n");
  console.log(`recorded ${path.relative(ROOT, file)}`);
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
