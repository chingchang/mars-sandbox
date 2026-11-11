// The workshop loop: conversation in, questions or a tested module out.
// The model's reply is parsed, the manifest and its fact ids are checked
// against the index, the source is compiled and smoke-tested, and every
// failure goes back to the model with the output, up to `tries` times.
import { validateManifest } from "../runtime/manifest.mjs";
import { compileAndTest, type BuildResult } from "./compile.mts";
import type { ChatMessage, Llm } from "./llm.mts";
import { buildSystemPrompt, liveFactIds, readIndex, readKeys, type FactIndex, type FactKeys } from "./prompt.mts";

export const DEFAULT_TRIES = 3;
export const MARKERS = ["===MANIFEST===", "===SOURCE===", "===EXPLANATION==="] as const;

export type ParsedReply =
  | { kind: "questions"; text: string }
  | { kind: "module"; manifestText: string; source: string; explanation: string };

/** Split a reply into its three sections; anything without the markers is a question for the player. */
export function parseReply(text: string): ParsedReply {
  const m = /===MANIFEST===([\s\S]*?)===SOURCE===([\s\S]*?)===EXPLANATION===([\s\S]*)$/.exec(text);
  if (!m) return { kind: "questions", text: text.trim() };
  const unfence = (s: string) => s.replace(/^[ \t]*```[\w-]*[ \t]*$/gm, "").trim();      // tolerate code fences around a section
  return { kind: "module", manifestText: unfence(m[1]), source: unfence(m[2]) + "\n", explanation: m[3].trim() };
}

export type Manifest = { name: string; fact_ids?: string[]; did_you_know?: { fact_id: string } } & Record<string, unknown>;

/** Static checks before compiling: manifest shape, fact ids, imports. Returns problems for the model. */
export function checkModule(reply: Extract<ParsedReply, { kind: "module" }>, index: FactIndex): { problems: string[]; manifest: Manifest | null } {
  const problems: string[] = [];
  let manifest: Manifest | null = null;
  try { manifest = JSON.parse(reply.manifestText) as Manifest; } catch (e) { problems.push(`manifest is not valid JSON: ${(e as Error).message}`); }
  if (manifest) {
    for (const err of validateManifest(manifest) as string[]) problems.push(`manifest: ${err}`);
    const live = new Set(liveFactIds(index));
    for (const id of manifest.fact_ids ?? []) {
      if (live.has(id)) continue;
      const f = index.facts[id];
      problems.push(f?.superseded_by ? `fact id "${id}" is superseded by "${f.superseded_by}"; cite that one` : `fact id "${id}" is not in the fact index`);
    }
  }
  if (!reply.source.trim()) problems.push("the source section is empty");
  for (const imp of reply.source.matchAll(/^\s*import\b[^;]*?from\s*["']([^"']+)["']/gm)) {
    if (imp[1] !== "./host") problems.push(`the module imports from "${imp[1]}"; only "./host" exists`);
  }
  if (!/export\s+function\s+init\s*\(/.test(reply.source) || !/export\s+function\s+tick\s*\(/.test(reply.source)) problems.push("the module must export init(): void and tick(dt: f32): void");
  return { problems, manifest };
}

/** A short identifier for the module, from its manifest name. */
export function slug(name: unknown): string {
  const s = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[0-9_]+|_+$/g, "").slice(0, 32);
  return s || "module";
}

export type Attempt = { attempt: number; ok: boolean; error: string | null; report: string | null };
export type WorkshopResult =
  | { type: "questions"; text: string; tries: number }
  | { type: "module"; name: string; manifest: Manifest; source: string; wasm: string; explanation: string; fact_ids: string[]; report: string; tries: number; log: Attempt[] }
  | { type: "failed"; error: string; tries: number; log: Attempt[] };

export type WorkshopOptions = {
  messages: ChatMessage[]; llm: Llm; tries?: number;
  index?: FactIndex; keys?: FactKeys; system?: string;
  build?: (source: string) => Promise<BuildResult>;
};

export async function runWorkshop({ messages, llm, tries = DEFAULT_TRIES, index = readIndex(), keys = readKeys(), system, build = compileAndTest }: WorkshopOptions): Promise<WorkshopResult> {
  const sys = system ?? buildSystemPrompt({ index, keys });
  const convo: ChatMessage[] = messages.map(m => ({ role: m.role, content: m.content }));
  const log: Attempt[] = [];
  for (let attempt = 1; attempt <= tries; attempt++) {
    const text = await llm(sys, convo);
    const reply = parseReply(text);
    if (reply.kind === "questions") return { type: "questions", text: reply.text, tries: attempt };
    const { problems, manifest } = checkModule(reply, index);
    let error: string | null = problems.length ? "MODULE CHECK FAILED:\n- " + problems.join("\n- ") : null;
    let built: BuildResult | null = null;
    if (!error) { built = await build(reply.source); if (!built.ok) error = built.error; }
    log.push({ attempt, ok: !error, error, report: built?.ok ? built.report : null });
    if (built?.ok && manifest) {
      return {
        type: "module", name: slug(manifest.name), manifest, source: reply.source, wasm: Buffer.from(built.wasm).toString("base64"),
        explanation: reply.explanation, fact_ids: [...(manifest.fact_ids ?? [])], report: built.report, tries: attempt, log,
      };
    }
    convo.push({ role: "assistant", content: text },
      { role: "user", content: `${error}\n\nFix the module. Reply with the same three sections (${MARKERS.join(", ")}) and the full corrected source.` });
  }
  return { type: "failed", error: log.at(-1)?.error ?? "no attempt", tries, log };
}
