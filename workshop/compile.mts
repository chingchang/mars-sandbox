// Compile one AssemblyScript source with the same flags as build.sh, apply the
// sandbox's resource policy, and run test/smoke.mjs on the result.
//
// The compiler runs in-process through its programmatic API with its file
// reads replaced: it can see exactly two files, module.ts (the source) and
// host.ts (behaviors/host.ts), served from memory, and nothing else exists for
// it (every other read returns null, directory listings are empty). So an
// import that names any other path fails as "not found" without touching the
// file system, whatever the static check in pipeline.mts missed. The standard
// library ships inside the compiler and is not read from disk.
import asc from "assemblyscript/asc";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./prompt.mts";
import { memoryPolicy } from "../runtime/wasm_limits.mjs";
import { MAX_MEMORY_PAGES } from "../runtime/registry.mjs";

/** Same as build.sh: stub runtime, no bulk memory, 256-page ceiling, abort() removed. */
export const ASC_FLAGS = ["--runtime", "stub", "-O3", "--noAssert", "--disable", "bulk-memory", "--maximumMemory", "256", "--use", "abort="];
export const SMOKE_TIMEOUT_MS = 20_000;
export const ENTRY = "module.ts", HOST = "host.ts";

export type CompileResult = { ok: true; wasm: Uint8Array } | { ok: false; error: string };
export type BuildResult = { ok: true; wasm: Uint8Array; report: string } | { ok: false; error: string };

/** Compile from memory. The compiler is given module.ts and host.ts and can read nothing else. */
export async function compileSource(source: string, root = ROOT): Promise<CompileResult> {
  const files = new Map<string, string>([[ENTRY, source], [HOST, await readFile(path.join(root, "behaviors", HOST), "utf8")]]);
  let wasm: Uint8Array | null = null;
  const stdout = asc.createMemoryStream(), stderr = asc.createMemoryStream();
  const result = await asc.main([ENTRY, "-o", "module.wasm", ...ASC_FLAGS], {
    stdout, stderr,
    readFile: (name: string, baseDir: string) => (baseDir === "." && files.has(name)) ? files.get(name)! : null,
    writeFile: (name: string, contents: Uint8Array | string) => { if (name === "module.wasm" && contents instanceof Uint8Array) wasm = contents; },
    listFiles: () => [],
  });
  if (result.error || !wasm) {
    const text = (stderr.toString() + stdout.toString()).trim() || (result.error ? String(result.error.message ?? result.error) : "no output produced");
    return { ok: false, error: "COMPILER ERROR:\n" + text };
  }
  return { ok: true, wasm };
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

/** Compile, apply the resource policy, smoke-test. The temp directory holds only the .wasm for the smoke test. */
export async function compileAndTest(source: string, root = ROOT): Promise<BuildResult> {
  const c = await compileSource(source, root);
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
