#!/usr/bin/env python3
"""
Superseded by the workshop server (workshop/server.mts, `npm run workshop`), which
runs the same loop as a service with the design agent's full prompt. Kept as the
small CLI version.

Player prompt -> AssemblyScript behavior -> compiled Wasm -> tested -> ready to hot-load.

    export ANTHROPIC_API_KEY=...        (or OPENAI_API_KEY with --provider openai)
    python3 generate.py "patrol in a figure eight and blink the LED when a rock is near" --name figure8

Then open the demo page and use "Load my own .wasm" to pick build/figure8.wasm,
or add it to pack.mjs META to embed it.

The loop: generate -> compile with asc -> run the headless test harness ->
on failure feed the compiler/test output back to the model, up to N tries.
"""
import argparse, json, os, pathlib, re, subprocess, sys, urllib.request

ROOT = pathlib.Path(__file__).parent
HOST_API = (ROOT / "behaviors" / "host.ts").read_text()
EXAMPLE = (ROOT / "behaviors" / "patrol.ts").read_text()

SYSTEM = f"""You write behavior modules for a Mars rover simulation, in AssemblyScript.
A module is ONE file that imports only from "./host" and exports exactly:
    export function init(): void
    export function tick(dt: f32): void
Rules:
- Use only the sensors and actuators declared in host.ts below. Nothing else exists.
- No strings, no arrays, no classes, no allocation: use f32/i32 globals for state.
- Call drive() every tick you want to move. The host clamps values.
- tick() must return fast (well under 1 ms) and must never loop waiting for something.
- Use log(code, value) with small integer codes; put a comment naming each code.
- Keep it under 80 lines. Output ONLY the AssemblyScript source, no prose, no fences.

host.ts:
{HOST_API}

Example module (for the prompt "patrol a 30 m square and avoid rocks"):
{EXAMPLE}
"""

def call_llm(provider, messages):
    if provider == "anthropic":
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", method="POST",
            headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
            data=json.dumps({"model": os.environ.get("MODEL", "claude-sonnet-4-5"), "max_tokens": 2000, "system": SYSTEM, "messages": messages}).encode())
        with urllib.request.urlopen(req) as r: return json.load(r)["content"][0]["text"]
    else:
        req = urllib.request.Request("https://api.openai.com/v1/chat/completions", method="POST",
            headers={"Authorization": "Bearer " + os.environ["OPENAI_API_KEY"], "content-type": "application/json"},
            data=json.dumps({"model": os.environ.get("MODEL", "gpt-4.1"), "messages": [{"role": "system", "content": SYSTEM}] + messages}).encode())
        with urllib.request.urlopen(req) as r: return json.load(r)["choices"][0]["message"]["content"]

def strip_fences(s):
    m = re.search(r"```(?:\w+)?\n(.*?)```", s, re.S)
    return (m.group(1) if m else s).strip() + "\n"

def compile_and_test(name):
    r = subprocess.run(["./build.sh", name], cwd=ROOT, capture_output=True, text=True)
    if r.returncode: return False, "COMPILER ERROR:\n" + r.stdout + r.stderr
    # smoke test: load it with mock imports for 30 s of sim time, catch traps/hangs
    r = subprocess.run(["node", "test/smoke.mjs", name], cwd=ROOT, capture_output=True, text=True, timeout=20)
    if r.returncode: return False, "TEST FAILURE:\n" + r.stdout + r.stderr
    return True, r.stdout

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt"); ap.add_argument("--name", required=True); ap.add_argument("--provider", default="anthropic"); ap.add_argument("--tries", type=int, default=3)
    a = ap.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9_]{1,30}", a.name): sys.exit("name must be a short snake_case identifier")
    messages = [{"role": "user", "content": f"Player prompt: {a.prompt}"}]
    for attempt in range(1, a.tries + 1):
        print(f"--- attempt {attempt}: asking the model")
        src = strip_fences(call_llm(a.provider, messages))
        (ROOT / "behaviors" / f"{a.name}.ts").write_text(src)
        ok, out = compile_and_test(a.name)
        print(out)
        if ok:
            print(f"ready: build/{a.name}.wasm  (source in behaviors/{a.name}.ts)"); return
        messages += [{"role": "assistant", "content": src}, {"role": "user", "content": out + "\nFix the module. Output only the full corrected source."}]
    sys.exit("gave up after retries; last source left in behaviors/")

if __name__ == "__main__": main()
