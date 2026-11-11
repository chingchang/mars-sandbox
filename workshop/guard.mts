// What stands in front of the workshop once it has a public URL (S1): the access
// code, the throttle on wrong codes, and the daily cap on model calls. Every
// request past these costs the owner's key, so they run before the body is read
// or the model called. Pure, with the clock injected, so tests can turn the day.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** The code from an `Authorization: Bearer <code>` header, or undefined. */
export function bearer(header: string | string[] | undefined): string | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h ?? "");
  return m?.[1];
}

/** Constant-time comparison of a presented code with the configured one. False when either is empty. */
export function codeMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest(), b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);                                  // same length by construction; the compare does not leak where they differ
}

export const THROTTLE_MAX = 5, THROTTLE_WINDOW_MS = 10 * 60_000, THROTTLE_KEYS = 10_000;

/**
 * Wrong attempts per client address: after `max` within `windowMs` the client is refused
 * until the oldest attempt in the window ages out, whatever code it sends meanwhile.
 * Bounded: past THROTTLE_KEYS clients the oldest entry is dropped.
 */
export class Throttle {
  readonly max: number;
  readonly windowMs: number;
  readonly #hits = new Map<string, number[]>();
  constructor(max = THROTTLE_MAX, windowMs = THROTTLE_WINDOW_MS) { this.max = max; this.windowMs = windowMs; }
  #recent(key: string, now: number): number[] {
    const kept = (this.#hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (kept.length) { this.#hits.delete(key); this.#hits.set(key, kept); } else this.#hits.delete(key);   // re-insert: newest last, for the bound below
    return kept;
  }
  /** Seconds until this client may try again; 0 when it is not blocked. */
  blockedFor(key: string, now: number): number {
    const r = this.#recent(key, now);
    return r.length >= this.max ? Math.max(1, Math.ceil((r[0] + this.windowMs - now) / 1000)) : 0;
  }
  /** Record a wrong attempt. */
  record(key: string, now: number): void {
    const r = this.#recent(key, now); r.push(now); this.#hits.set(key, r);
    while (this.#hits.size > THROTTLE_KEYS) { const oldest = this.#hits.keys().next().value; if (oldest === undefined) break; this.#hits.delete(oldest); }
  }
  get clients(): number { return this.#hits.size; }
}

export const DEFAULT_DAILY_CAP = 50;

/**
 * Model calls per UTC day. With a `file` the count survives a restart or a stopped machine
 * (written on every change, atomically); without one it lives in the process and a restart
 * starts the day over. The file's directory must exist: a missing mount fails at start, not
 * silently in memory.
 */
export class DailyCap {
  readonly cap: number;
  readonly file: string | undefined;
  #day = "";
  #used = 0;
  #warned = false;
  constructor(cap = DEFAULT_DAILY_CAP, file?: string) {
    if (!Number.isInteger(cap) || cap < 1) throw new Error(`the daily cap must be a positive integer, not ${cap}`);
    this.cap = cap; this.file = file;
    if (file) { this.#load(); this.#save(true); }
  }
  static day(now: number): string { return new Date(now).toISOString().slice(0, 10); }
  /** Next UTC midnight after `now`, as an ISO string. */
  static reopensAt(now: number): string { const d = new Date(now); d.setUTCHours(24, 0, 0, 0); return d.toISOString(); }
  #load(): void {
    let text: string;
    try { text = readFileSync(this.file!, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error(`the daily cap state ${this.file} cannot be read: ${(e as Error).message}`); }
    try { const j = JSON.parse(text); if (typeof j.day === "string" && Number.isInteger(j.used) && j.used >= 0) { this.#day = j.day; this.#used = j.used; return; } } catch {}
    console.error(`workshop: the daily cap state ${this.file} is not what the server writes; starting the count over`);
  }
  #save(strict = false): void {
    if (!this.file) return;
    try { const tmp = this.file + ".tmp"; writeFileSync(tmp, JSON.stringify({ day: this.#day, used: this.#used })); renameSync(tmp, this.file); }
    catch (e) {
      if (strict) throw new Error(`the daily cap state ${this.file} cannot be written (does the state directory exist?): ${(e as Error).message}`);
      if (!this.#warned) { this.#warned = true; console.error(`workshop: the daily cap state ${this.file} could not be written; counting in memory meanwhile: ${(e as Error).message}`); }
    }
  }
  #roll(now: number): void { const d = DailyCap.day(now); if (d !== this.#day) { this.#day = d; this.#used = 0; this.#save(); } }
  get used(): number { return this.#used; }
  remaining(now: number): number { this.#roll(now); return Math.max(0, this.cap - this.#used); }
  /** Count one model call; false (and nothing counted) when the day's cap is used up. */
  take(now: number): boolean { this.#roll(now); if (this.#used >= this.cap) return false; this.#used++; this.#save(); return true; }
  /** What the page shows when the day is used up: plain words and when it reopens. */
  closedMessage(now: number): string {
    const at = DailyCap.reopensAt(now), hours = Math.max(1, Math.round((Date.parse(at) - now) / 3_600_000));
    return `the workshop is closed for today: its ${this.cap} model call${this.cap === 1 ? "" : "s"} for the day are used up; it opens again at ${at.slice(11, 16)} UTC, in about ${hours} hour${hours === 1 ? "" : "s"}`;
  }
}

/** Thrown by the guarded model call when the day's cap is reached mid-request. */
export class ClosedError extends Error {
  reopensAt: string;
  constructor(message: string, reopensAt: string) { super(message); this.reopensAt = reopensAt; }
}
