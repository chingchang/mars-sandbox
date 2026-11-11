// The design agent's system prompt, assembled from the files the server and
// the page share: the host API, the manifest schema, one example module, the
// fact index and the principles in CLAUDE.md. Pure: same inputs, same text, so
// the prompt caches across requests (it changes only when a file changes).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type FactRecord = {
  id: string; label: string; value: unknown; unit?: string; display_unit?: string; tier: string;
  source_ids: string[]; uncertainty?: Record<string, unknown>; superseded_by?: string; notes?: string;
};
export type FactIndex = {
  content_hash: string; tier_order: string[];
  facts: Record<string, FactRecord>;
  sources: Record<string, { citation: string; urls?: string[] }>;
};
export type FactKeys = { keys: Record<string, number> };

export function readIndex(root = ROOT): FactIndex {
  return JSON.parse(readFileSync(path.join(root, "facts/index.json"), "utf8")) as FactIndex;
}
export function readKeys(root = ROOT): FactKeys {
  return JSON.parse(readFileSync(path.join(root, "runtime/fact_keys.json"), "utf8")) as FactKeys;
}

/** Fact ids the agent may cite: everything in the index that has not been superseded, sorted. */
export function liveFactIds(index: FactIndex): string[] {
  return Object.keys(index.facts).filter(id => !index.facts[id].superseded_by).sort();
}

export function factKeyName(id: string): string {
  return "FACT_" + id.replace(/\./g, "_").toUpperCase();
}

function describeValue(f: FactRecord): string {
  const v = f.value as Record<string, unknown> | number | string | null;
  if (typeof v === "number") return `${v}${f.unit ? " " + f.unit : ""}${f.display_unit ? " (" + f.display_unit + ")" : ""}`;
  if (typeof v === "string") return JSON.stringify(v.length > 160 ? v.slice(0, 157) + "..." : v);
  if (v && typeof v === "object") {
    const series = (v as { series?: unknown }).series;
    const n = Array.isArray(series) ? (series as unknown[]).flat(Infinity).length : 0;
    const axes = (v as { axes?: Record<string, unknown> }).axes;
    if (n) return `table of ${n} values in ${f.unit ?? "?"} over ${Object.keys(axes ?? {}).join(" x ") || "an axis"}; fact() returns NaN for it, fact_tier() works; the inspector shows it`;
    return `structured (${Object.keys(v).join(", ")}); not readable through fact()`;
  }
  return String(v);
}

function describeUncertainty(u: Record<string, unknown> | undefined): string {
  if (!u) return "";
  const t = u.type;
  if (t === "plus_minus") return ` ±${u.value}`;
  if (t === "range") return ` (range ${u.low}..${u.high})`;
  if (t === "series") return " (spread given per value)";
  if (typeof u.value === "number") return ` (${t} ${u.value})`;
  return t ? ` (${String(t)})` : "";
}

/** One line per live fact: id, tier, label, value, key, sources. */
export function factLines(index: FactIndex, keys: FactKeys): string[] {
  return liveFactIds(index).map(id => {
    const f = index.facts[id];
    const key = keys.keys[id];
    const keyNote = key === undefined ? "no key" : typeof f.value === "number" ? `${factKeyName(id)} = ${key}, fact() returns the value` : `${factKeyName(id)} = ${key}`;
    const cites = f.source_ids.map(s => (index.sources[s]?.citation ?? s).slice(0, 140)).join(" | ");
    return `- ${id} [${f.tier}] ${f.label}: ${describeValue(f)}${describeUncertainty(f.uncertainty)}. Key: ${keyNote}. Sources: ${cites}`;
  });
}

/** The principles section of CLAUDE.md: from "Principle 1" up to "Where things live". */
export function principles(root = ROOT): string {
  const text = readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  const start = text.indexOf("## Principle 1");
  const end = text.indexOf("## Where things live");
  if (start < 0) throw new Error("CLAUDE.md has no '## Principle 1' section");
  return text.slice(start, end > start ? end : undefined).trim();
}

export const REPLY_PROTOCOL = `How to reply.

- Before the first build in a conversation, always ask first. Every request leaves at least one choice open that a fact in the index bears on (what the thing is made of, how big it is, where it reads from, how it survives the cold, the thin air or the radiation, what it breathes, what a shape buys it here, which record a number should come from, what a threshold should be and why). Find the one or two choices that matter most, reply with your questions in plain prose, each tied to the fact id that makes it a question, written as [fact.id] in brackets, and let the player decide. Do not build until the player has answered. Accept the fantasy, ask about the details, never veto, never lecture: the question is where the player learns something true about Mars.
- If the request leaves no such choice at all, or the player has already answered a question in this conversation, build. If building would need a Mars number the index does not have, say so and ask, or label it as the player's assumption.
- When you build, reply with exactly these three sections and nothing else:

===MANIFEST===
a JSON object that validates against the manifest schema; fact_ids lists every fact id the design rests on; did_you_know quotes one of them in the player's words, with that fact_id
===SOURCE===
one AssemblyScript file that imports only from "./host" and exports init(): void and tick(dt: f32): void
===EXPLANATION===
a short explanation for the player: what it does, which facts shaped it (cite ids in brackets), and which details are the player's own assumptions rather than facts

- Every Mars number you state, in prose, in comments or in code, comes from the fact index below, cited by id, or is read at run time with fact(FACT_...). If the index does not have a number, say so and ask, or label it as the player's assumption. Never make one up.
- AssemblyScript rules: no strings, arrays, classes or allocation (the runtime is stub); f32 and i32 globals for state; tick() returns fast and never waits; log(code, value) with small integer codes and a comment naming each code; call at least one actuator (drive, spawn, pose, state_set, signal_emit) or the smoke test fails; keep it under 120 lines.
- If a later message brings compiler or test output, fix the module and reply in the same three sections with the full corrected source.`;

export function buildSystemPrompt({ root = ROOT, index = readIndex(root), keys = readKeys(root) }: { root?: string; index?: FactIndex; keys?: FactKeys } = {}): string {
  const read = (p: string) => readFileSync(path.join(root, p), "utf8").trim();
  const lines = factLines(index, keys);
  return [
    "You are the design agent in the workshop of Mars Sandbox: a shared, persistent, scientifically grounded Mars where players invent things in natural language. You turn a player's idea into a behaviour module (AssemblyScript compiled to Wasm) that runs sandboxed in their world, and you make every invention an opportunity to learn something true about Mars. You are a collaborator, not an oracle: you ask, propose, cite and explain.",
    REPLY_PROTOCOL,
    "# Principles (from CLAUDE.md)\n\nThe numbers inside the principles below are illustrations from the project charter, not citable facts; cite only the fact index at the end of this prompt.\n\n" + principles(root),
    "# Host API (docs/HOST_API.md)\n\n" + read("docs/HOST_API.md"),
    "# Host declarations (behaviors/host.ts): the only module a behaviour may import\n\n```typescript\n" + read("behaviors/host.ts") + "\n```",
    "# Manifest schema (runtime/manifest.schema.json)\n\n```json\n" + read("runtime/manifest.schema.json") + "\n```",
    "# Example: the weather station\n\nManifest:\n```json\n" + read("behaviors/weather_station.manifest.json") + "\n```\n\nSource:\n```typescript\n" + read("behaviors/weather_station.ts") + "\n```",
    `# Fact index (facts/index.json, content hash ${index.content_hash}; ${lines.length} facts, superseded records omitted)\n\nTiers from strongest to weakest: ${index.tier_order.join(" > ")}. Cite ids exactly as written.\n\n` + lines.join("\n"),
  ].join("\n\n");
}
