// Compile one AssemblyScript source with the same flags as build.sh, apply the
// sandbox's resource policy, and run test/smoke.mjs on the result.
//
// The compiler runs in a worker thread (compile_worker.mts) with a time limit,
// so a generated source that makes the compiler loop, overflow its stack or
// exit cannot take the server with it: each of those becomes a compiler error
// the retry loop can hand back to the model, and the server keeps answering
// meanwhile. Inside the worker the compiler can read only module.ts and
// host.ts, served from memory.
//
// What the limits cover. The worker's resourceLimits bound its JavaScript
// heap (COMPILE_MEMORY_MB), which is where a runaway compiler data structure
// ends up. They do not bound the compiler's own WebAssembly memory: a source
// with `memory.data(2000000000)` took the server process to about 4.7 GB
// resident for 18 s before the compiler refused it (measured in review), and
// two such lines reached 3.1 GB before the timer cut them. So the real bound
// on a compile is the time limit, at roughly 4 GB of peak memory per compile.
// Builds run one at a time through buildQueue, so that peak cannot multiply
// across requests; acceptable for the MVP, to revisit with a child process
// and an OS memory limit when the workshop is deployed.
//
// Why one at a time: the smoke test measures the worst single tick on the
// wall clock against a 2 ms budget. A smoke test sharing the CPU with another
// compile measured 4 to 28 ms for a module that takes 0.5 ms alone, so a
// correct module was rejected for a false reason. Serialising builds makes a
// build's result independent of what else the server is doing.
import { Worker } from "node:worker_threads";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./prompt.mts";
import { memoryPolicy } from "../runtime/wasm_limits.mjs";
import { MAX_MEMORY_PAGES } from "../runtime/registry.mjs";
import type { CompileResult } from "./compile_worker.mts";
import { BuildQueue } from "./queue.mts";
export { ASC_FLAGS, ENTRY, HOST, type CompileResult } from "./compile_worker.mts";
export { BuildQueue, BusyError } from "./queue.mts";

/** The server's queue: one build running, at most four waiting. */
export const buildQueue = new BuildQueue(4);

export const COMPILE_TIMEOUT_MS = 20_000, COMPILE_MEMORY_MB = 512, SMOKE_TIMEOUT_MS = 20_000;
export type CompileLimits = { timeoutMs?: number; memoryMb?: number };
export type BuildResult = { ok: true; wasm: Uint8Array; report: string } | { ok: false; error: string };

/** Compile in a limited worker thread. Never throws: a freeze, crash, exit or heap exhaustion is a compiler error. Not queued by itself; compileAndTest is. */
export async function compileSource(source: string, root = ROOT, { timeoutMs = COMPILE_TIMEOUT_MS, memoryMb = COMPILE_MEMORY_MB }: CompileLimits = {}): Promise<CompileResult> {
  const host = await readFile(path.join(root, "behaviors/host.ts"), "utf8");
  return new Promise(resolve => {
    let done = false;
    const finish = (r: CompileResult) => { if (!done) { done = true; clearTimeout(killer); resolve(r); } };
    const worker = new Worker(new URL("./compile_worker.mts", import.meta.url), {
      workerData: { source, host },
      resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: 64 },
      stdout: true, stderr: true,                                     // the compiler's crash banner stays out of the server log
    });
    const killer = setTimeout(() => { finish({ ok: false, error: `COMPILER ERROR:\nthe compiler did not finish within ${timeoutMs / 1000} s; the module is too expensive to compile (deep recursion, huge functions or inlining)` }); void worker.terminate(); }, timeoutMs);
    let said = "";                                                     // what the compiler printed before dying, for the crash message
    const take = (b: Buffer) => { if (said.length < 4000) said += b.toString(); };
    worker.stdout.on("data", take); worker.stderr.on("data", take);
    const banner = () => { const line = said.split("\n").map(l => l.trim()).find(l => /crash|error|exception/i.test(l)); return line ? ` (${line.slice(0, 160)})` : ""; };
    worker.on("message", (m: CompileResult) => { finish(m); void worker.terminate(); });
    worker.on("error", (e: Error & { code?: string }) => finish({ ok: false, error: e.code === "ERR_WORKER_OUT_OF_MEMORY" ? `COMPILER ERROR:\nthe compiler's JavaScript heap ran out of memory (limit ${memoryMb} MB); the module is too large to compile` : `COMPILER ERROR:\nthe compiler crashed: ${e.message}` }));
    worker.on("exit", code => finish({ ok: false, error: `COMPILER ERROR:\nthe compiler crashed and stopped (exit code ${code}) without producing a module${banner()}; the module is too large or too deeply nested to compile` }));
  });
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (b: Buffer) => { if (out.length < 64_000) out += b.toString(); };
    child.stdout.on("data", take); child.stderr.on("data", take);
    const killer = setTimeout(() => { child.kill("SIGKILL"); out += `\n(killed after ${timeoutMs} ms)`; }, timeoutMs);
    child.on("error", e => { clearTimeout(killer); resolve({ code: -1, out: out + "\n" + e.message }); });
    child.on("close", code => { clearTimeout(killer); resolve({ code, out }); });
  });
}

/**
 * Compile, apply the resource policy, smoke-test; one build at a time through the queue (BusyError
 * if the queue is full). The temp directory holds only the .wasm for the smoke test.
 */
export function compileAndTest(source: string, root = ROOT, limits: CompileLimits = {}, queue: BuildQueue = buildQueue): Promise<BuildResult> {
  return queue.run(() => buildNow(source, root, limits));
}

async function buildNow(source: string, root: string, limits: CompileLimits): Promise<BuildResult> {
  const c = await compileSource(source, root, limits);
  if (!c.ok) return c;
  const why = memoryPolicy(c.wasm, MAX_MEMORY_PAGES);
  if (why) return { ok: false, error: "RESOURCE POLICY: " + why };
  const dir = await mkdtemp(path.join(tmpdir(), "mars-workshop-"));
  try {
    const wasmPath = path.join(dir, "module.wasm");
    await writeFile(wasmPath, c.wasm);
    const t = await run(process.execPath, [path.join(root, "test/smoke.mjs"), wasmPath], root, SMOKE_TIMEOUT_MS);
    if (t.code !== 0) return { ok: false, error: "TEST FAILURE:\n" + t.out.replaceAll(wasmPath, "module.wasm").trim() };
    return { ok: true, wasm: c.wasm, report: t.out.trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
