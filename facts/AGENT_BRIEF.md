# Brief for the coding agent, and the supervisor's review checklist

You are building the knowledge layer of Mars Sandbox on top of the existing
rover PoC in this repo. Read `README.md` in this folder first, then
`sources.md`, then `hypotheses.md`. The JSON bundles are the deliverable you
extend; the supervisor (a separate reviewing agent) will check your work
against the checklist at the bottom.

## Ground rules

1. **No number without a source.** If you cannot point at a paper, archive or
   instrument, do not write the number. Open an entry in `hypotheses.md` instead.
2. **Never upgrade a tier.** A press-release figure is not `measured` until you
   have the paper or the PDS record. A model output is `modeled` even if everyone
   quotes it as fact.
3. **Replace, do not overwrite.** When a better value arrives, add
   `superseded_by` to the old record and keep it. Bump the bundle version.
4. **Do not use your own memory of Mars.** You almost certainly remember numbers.
   Some are wrong, some are stale, and none have provenance. Fetch and cite.
5. **Keep the human-readable files current.** A new fact id that touches an open
   question gets a line in `hypotheses.md`.

## Tasks, in order

### V1. Validation tooling (do this first)
- `facts/validate.mjs`: validate every `*.json` against `schema.json`
  (use `ajv`), check every `source_ids` entry resolves to a `## ` heading in
  `sources.md`, check every `depends_on` resolves to an existing id, check
  `derived` records carry a `formula`, fail the build on any violation.
- Add it to `package.json` scripts and to CI.
- Emit `facts/index.json`: flat id → record map plus bundle versions, for the engine.

### T1. Terrain ingestion
- Download the MOLA MEG128 tile covering Jezero (`mola-megdr`), reproject to a
  local metre grid centred on 18.44 N 77.45 E, export a heightmap for a 40 x 40 km
  region at ~460 m/px as a 16-bit PNG plus a JSON sidecar (datum, scale, source, version).
- Locate the HiRISE 1 m DTM from `stack-2020-jezero-map` supplementary material (or the
  USGS/PDS HiRISE DTM for the landing ellipse) and export a 5 x 5 km playable region at 1 m/px.
- Replace the procedural terrain in `web/app.html` with the real heightmap. Keep the
  procedural one behind a flag for tests.

### F2. Replace every APPROX value in `jezero.json`
- Find the MEDA PDS bundle (`meda-pds-archive`), pull pressure and air-temperature
  series for Mars Year 36, compute: annual pressure min/max/mean, typical diurnal
  min/max by season, diurnal swing distribution. Write them as `measured` records with
  the bundle id, product version and the sol range used in `notes`.
- Pull the Mastcam-Z / RDS optical depth series for the same period; write typical,
  10th and 90th percentile tau.
- Record the script that produced each number under `facts/derive/` so it is reproducible.

### F3. Climatology from the Mars Climate Database
- Request MCD 6.1 access (`mcd-lmd`), or use the web interface for a first pass.
- Generate, for Jezero, diurnal profiles of surface temperature, pressure and
  downwelling solar flux at 12 solar longitudes for the "climatology" and "storm"
  dust scenarios. Store as `modeled` time-series records (value = array, with the
  MCD version and scenario in `notes`).
- This is what the engine should use for seasons and for sites the rovers never visited.

### H1. Host API: expose facts to Wasm modules
- Extend `behaviors/host.ts` with an `ENV_*` key block generated from `facts/index.json`
  (integer key per fact id; keep keys stable by appending only).
- `read(key)` for an env key returns the current value as computed by the engine
  (e.g. outside temperature now), not the static mean. The static records drive the
  engine's climate model; modules see the live state.
- Add `fact_tier(key) -> i32` so a module can report the lowest tier it depends on.
  The inspector shows that tier on the object.

### P1. Primitives library (vetted physics, outside the fact base)
- `sim/primitives/`: conduction through a layered wall, grey-body radiation to sky,
  convective loss in thin CO2 (note: Mars convection is weak; document the correlation
  used), PV output vs irradiance and cell temperature, battery energy balance, a
  degree-day crop growth model, air density from p, T, M.
- Each primitive: pure function, documented equation, unit test with a hand-computed
  case, and a citation for the correlation.
- The LLM design agent composes these; it must not re-derive physics in generated code.

### E1. Conservation audit in the engine
- Every component declares power in/out, heat out, mass flows. Each tick the engine
  sums per bus and asserts energy and mass balance within tolerance. A violating
  component is disabled and the violation logged with the component's name. This is
  the main defence against a plausible-looking but wrong generated model.

### G1. Greenhouse demo (after the above)
- A greenhouse component built only from primitives and fact reads, with a solar array
  and battery as sibling components on the power bus, placed at Jezero in the real
  terrain, run through a sol with MCD climatology, showing internal temperature, heater
  power and crop state. Acceptance: with the heater off it must trend toward ambient
  overnight; with a 2 kW array and no storage it must fail the first night; the Jan 2022
  storm scenario must cut power by roughly the factor implied by tau = 2.

## Supervisor's review checklist

The reviewing agent will reject work that fails any of these. Expect it.

**Provenance**
- [ ] Every fact has a `source_ids` entry that resolves, and the cited source actually
      contains that number (the reviewer will spot-check by fetching the source).
- [ ] No tier has been upgraded beyond what the source supports.
- [ ] Every `derived` value recomputes from its `depends_on` using the stated formula
      (the reviewer will recompute).
- [ ] Nothing marked APPROX remains without an open task or a replacement.

**Honesty of the model**
- [ ] Uncertainty is carried through to the UI, not dropped at the first calculation.
- [ ] Hypotheses are labelled in the inspector when a design depends on them.
- [ ] Player assumptions live in the world overlay, never in `facts/`.
- [ ] The conservation audit catches a deliberately broken component (the reviewer will
      submit one that creates energy).

**Engineering quality**
- [ ] `facts/validate.mjs` runs in CI and fails on a bad record (the reviewer will add one).
- [ ] Terrain products carry datum, scale, source and version in a sidecar.
- [ ] Derivation scripts under `facts/derive/` reproduce every F2/F3 number from raw data.
- [ ] Primitives have unit tests with hand-computed expected values and cited correlations.
- [ ] Generated modules still pass the existing Wasm import allow-list and watchdog tests.

**Scope discipline**
- [ ] No physics inside `facts/`. No facts inside `sim/primitives/`.
- [ ] No mission-architecture claims (DRA 5.0, Mars Direct, SpaceX) stored as facts.
- [ ] No new simulation capability was added without a test that would fail if it were wrong.

When you disagree with a checklist item, say so in the PR description with the
reason. The supervisor would rather argue than discover a silent workaround.
