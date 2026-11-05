# Mars Sandbox PoC: hot-loading LLM-written Wasm behaviors

Proof of concept for the "player extends the running game" loop:

    player prompt -> LLM writes AssemblyScript against a tiny host API
                  -> asc compiles it to Wasm (hundreds of bytes)
                  -> headless test (imports, traps, hangs, budget)
                  -> browser fetches the bytes and instantiates them in a Web Worker
                  -> world keeps running; old module terminated once the new one's init() succeeds

## Layout

    behaviors/host.ts        the whole host API: 14 sensor keys, 5 actuator/log imports, 2 memory slots
    behaviors/*.ts           sample "generated" behaviors (patrol, return_home, seek_target, runaway)
    build.sh                 compile behaviors to build/*.wasm
    test/run.mjs             checks each sample does its job in a toy world
    test/smoke.mjs           generic acceptance test used by generate.py
    test/browser.py          drives the real page in headless Chrome (playwright)
    generate.py              prompt -> source -> compile -> test -> retry loop (Anthropic or OpenAI key)
    web/app.html             the Three.js world + worker host (template)
    pack.mjs                 embeds compiled modules into dist/index.html (single file)

## Run

    npm install
    ./build.sh && node test/run.mjs && node pack.mjs
    python3 -m http.server -d dist 8000      # open http://localhost:8000

Generate a new behavior from a prompt and load it with "Load my own .wasm":

    export ANTHROPIC_API_KEY=...
    python3 generate.py "zigzag toward the charger and stop 3 m short" --name zigzag

## What the host enforces (see web/app.html, worker-src)

- import allow-list checked with `WebAssembly.Module.imports` before instantiation
- sensors are a copied snapshot; the module never touches authoritative state
- actions are requests; the main thread clamps and applies them
- 2 ms per-tick budget, disabled after 3 consecutive overruns
- 400 ms watchdog; `worker.terminate()` on a hang (see the "runaway" module)
- 64 floats of host-owned memory survive a module reload (v2 inherits v1 state)

## Honest caveats

The four sample behaviors were written by hand to the same prompt+API contract
generate.py uses, so the demo shows the load/isolate/swap half of the loop with
real Wasm; run generate.py with a key to see the generation half.
Physics is a toy. The terrain is procedural, not Jezero.
