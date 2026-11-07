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
    facts/                   the sourced Mars knowledge layer (see facts/README.md)
    facts/validate.mjs       validates the fact bundles and emits facts/index.json
    terrain/*.py             PDS terrain ingestion (MOLA MEGDR, USGS HiRISE DTM) -> web/terrain/*.png + .json sidecars
    web/png16.mjs            16-bit PNG decoder + heightmap sampler shared by the client and tests
    test/terrain.test.mjs    every heightmap decodes to what its sidecar claims
    test/facts.test.mjs      validator tests (each violation class has a fixture)

## Run

    npm install
    npm run facts            # validate facts/*.json, write facts/index.json
    ./build.sh && npm test && node pack.mjs
    python3 -m http.server -d dist 8000      # open http://localhost:8000

Generate a new behavior from a prompt and load it with "Load my own .wasm":

    export ANTHROPIC_API_KEY=...
    python3 generate.py "zigzag toward the charger and stop 3 m short" --name zigzag

## Terrain

The world is the real Jezero landing site. `web/terrain/` holds 16-bit PNG
heightmaps with JSON sidecars (datum, scale, source, version, hashes), all
produced by reproducible scripts from PDS products:

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    curl -o data/raw/mola/megt44n000hb.img https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/megt44n000hb.img
    curl -o data/raw/mola/megt44n000hb.lbl https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/megt44n000hb.lbl
    .venv/bin/python -I terrain/mola_jezero.py --img data/raw/mola/megt44n000hb.img --lbl data/raw/mola/megt44n000hb.lbl \
        --out web/terrain/jezero_mola_40km.png --size-km 40 --res-m 460
    .venv/bin/python -I terrain/hirise_jezero.py fetch  --size-km 5     # ~430 MB of rows by HTTP range request
    .venv/bin/python -I terrain/hirise_jezero.py export --size-km 5 --res-m 1 --out web/terrain/jezero_hirise_5km.png

`?terrain=hirise` (default) is the USGS Mars 2020 HiRISE DTM mosaic at 1 m/px;
`?terrain=mola` the MOLA MEGDR crater-scale context at 460 m/px;
`?terrain=procedural` the original toy heightfield, kept for tests. World frame:
x east, z south, y up, origin at the landing site (y = 0 is the site's own
elevation; the sidecar carries the height above the datum).

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
Physics is a toy. The terrain is real Jezero (HiRISE and MOLA); the rocks are not.
