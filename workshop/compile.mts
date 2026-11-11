// Compile one AssemblyScript source with the same flags as build.sh, apply the
// sandbox's resource policy, and run test/smoke.mjs on the result. Everything
// happens in a fresh temporary directory that is removed afterwards.
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./prompt.mts";
import { memoryPolicy } from "../runtime/wasm_limits.mjs";
import { MAX_MEMORY_PAGES } from "../runtime/registry.mjs";

/** Same as build.sh: stub runtime, no bulk memory, 256-page ceiling, abort() removed. */
export const ASC_FLAGS = ["--runtime", "stub", "-O3", "--noAssert", "--disable", "bulk-memory", "--maximumMemory", "256", "--use", "abort="];
export const COMPILE_TIMEOUT_MS = 60_000, SMOKE_TIMEOUT_MS = 20_000;

export type BuildResult = { ok: true; wasm: Uint8Array; report: string } | { ok: false; error: string };

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

export async function compileAndTest(source: string, root = ROOT): Promise<BuildResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "mars-workshop-"));
  try {
    await copyFile(path.join(root, "behaviors/host.ts"), path.join(dir, "host.ts"));   // the only thing "./host" can resolve to
    const src = path.join(dir, "module.ts"), wasmPath = path.join(dir, "module.wasm");
    await writeFile(src, source);
    const asc = path.join(root, "node_modules/assemblyscript/bin/asc.js");
    const c = await run(process.execPath, [asc, src, "-o", wasmPath, ...ASC_FLAGS], root, COMPILE_TIMEOUT_MS);
    if (c.code !== 0) return { ok: false, error: "COMPILER ERROR:\n" + c.out.replaceAll(dir + path.sep, "").trim() };
    const wasm = new Uint8Array(await readFile(wasmPath));
    const why = memoryPolicy(wasm, MAX_MEMORY_PAGES);
    if (why) return { ok: false, error: "RESOURCE POLICY: " + why };
    const t = await run(process.execPath, [path.join(root, "test/smoke.mjs"), wasmPath], root, SMOKE_TIMEOUT_MS);
    if (t.code !== 0) return { ok: false, error: "TEST FAILURE:\n" + t.out.trim() };
    return { ok: true, wasm, report: t.out.trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
