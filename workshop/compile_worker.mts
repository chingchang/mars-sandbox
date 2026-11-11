// The compiler, in its own thread. Started by compile.mts with
// { source, host } and a time and memory limit; posts { ok, wasm } or
// { ok: false, error }. The compiler can read exactly two files, module.ts
// (the source) and host.ts (behaviors/host.ts), served from memory; every
// other read returns null and directory listings are empty, so an import of
// any other path fails as "not found" without touching the file system. The
// standard library ships inside the compiler. A throw inside the compiler is
// caught and reported; a freeze or a crash is handled by the parent.
import asc from "assemblyscript/asc";
import { parentPort, workerData } from "node:worker_threads";

export const ENTRY = "module.ts", HOST = "host.ts";
/** Same as build.sh: stub runtime, no bulk memory, 256-page ceiling, abort() removed. */
export const ASC_FLAGS = ["--runtime", "stub", "-O3", "--noAssert", "--disable", "bulk-memory", "--maximumMemory", "256", "--use", "abort="];

export type CompileResult = { ok: true; wasm: Uint8Array } | { ok: false; error: string };

export async function compileInMemory(source: string, host: string): Promise<CompileResult> {
  const files = new Map<string, string>([[ENTRY, source], [HOST, host]]);
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

if (parentPort) {
  const { source, host } = workerData as { source: string; host: string };
  compileInMemory(source, host)
    .then(r => parentPort!.postMessage(r))
    .catch(e => parentPort!.postMessage({ ok: false, error: `COMPILER ERROR:\nthe compiler threw: ${e instanceof Error ? e.message : String(e)}` }));
}
