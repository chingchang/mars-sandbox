# Brief for the coding agent, and the supervisor's review checklist

Version 2 (2026-11-09). Version 1 built the knowledge layer; this version
turns the project toward the MVP: a player talks to the design agent and
creates something the app has no existing concept of, and it hot-loads into
the running world. Physics realism is deferred, deliberately, to Phase D.

Read `CLAUDE.md` first, then `docs/DEV_GUIDE.md` for the component map, then
this file. The supervisor (a separate reviewing agent) reviews every PR against
the checklist at the bottom and posts in the repo; you do not need Ching to
relay. Stop for review at each PR.

## Ground rules (unchanged)

1. **No number without a source.** If you cannot point at a paper, archive or
   instrument, do not write the number. Open an entry in `hypotheses.md` instead.
2. **Never upgrade a tier.** A press-release figure is not `measured` until you
   have the paper or the PDS record. A model output is `modeled` even if everyone
   quotes it as fact.
3. **Replace, do not overwrite.** When a better value arrives, add
   `superseded_by` to the old record and keep it. Bump the bundle version.
4. **Do not use your own memory of Mars.** Fetch and cite.
5. **Keep the human-readable files current.** `hypotheses.md`, `docs/DEV_GUIDE.md`
   and this brief change when the system changes.
6. **Keep the sandbox guarantees.** Import allow-list, sensor snapshot not state,
   actions as requests, per-tick budget, watchdog, no gap on hot-swap. Every
   existing test keeps passing. Append host API keys; never renumber.
7. **One task per PR**, with a description of what was built, how it was tested,
   which sources were added, and anything you disagreed with here and why.

## Status

| Task | State |
|---|---|
| V1 validator + index | merged |
| T1 terrain (MOLA + HiRISE) | merged |
| F2 MEDA MY36 + tau from literature | merged (PRs 3 and 4) |
| F3 MCD climatology | merged (PR 5); full-database access and the 6.2 release date pending with LMD |
| R1 multi-module runtime | merged (PR 7) |
| X1 generic host API + manifest | merged (PRs 9, 11) |
| W1 workshop server | merged (PR 12) |
| W2 workshop panel | merged (PR 14) |
| A1 acceptance | merged (PRs 16, 17): 4 of 5 pass on the frozen prompt; prompt 3 fails on the page's rotation order (`docs/HOST_API.md` does not state it; a follow-up the owner decides) |
| S1 deploy to a production site | in review |

## Phase C: the MVP (do these next, in order)

Goal, in one sentence: from a cold start, a player types a request for
something nothing in the app anticipates, the design agent asks at least one
fact-grounded question, and within two tries a working object appears where the
player tapped, running in the sandbox, visible in the inspector.

### R1. Multi-module runtime
Today the runtime has one slot (the rover's controller). Make it many.
- `runtime/` module: a registry of live objects, each with an id, owner, version,
  position, a manifest, and zero or one module worker.
- Load, replace and unload per object. Replacement builds the new worker beside
  the old one and swaps only after `init()` succeeds (as today).
- Per-object tick scheduling at 20 Hz with the existing budget and watchdog
  applied per worker. A hung module kills only its own object.
- The rover becomes the first object in the registry, not a special case.
- Tests: three objects with three modules run together; one hangs and is
  terminated while the other two keep ticking; replacing one leaves the others'
  state untouched.

### X1. Generic host API and manifest
Add the calls that let a module be anything, keeping the surface small.
- Visuals: `spawn(shape, w, h, d, r, g, b) -> handle` with shapes box, cylinder,
  sphere, cone, panel; `pose(handle, x, y, z, yaw, pitch)`; `remove(handle)`.
  Handles are per-object; a module cannot touch another object's shapes. Cap at
  32 shapes per object.
- State: `state_set(slot, value)`; the manifest declares slot labels and units so
  the inspector renders a panel for a type it has never seen. 16 slots.
- Signals: `signal_emit(code, value)` and `signal_read(code) -> value` through
  the host; the manifest declares codes it emits and codes it listens to. Signals
  are world-scoped and expire after one tick unless re-emitted.
- World queries: `terrain_height(x, z)`, `nearest(kind, x, z) -> distance` and
  `nearest_bearing(kind, x, z)` for kinds rover, rock, charger, object.
- Environment: the existing reads (time, sun, temperature, pressure, dust) stay;
  add `fact(key) -> value` and `fact_tier(key)` backed by `facts/index.json`.
- Manifest schema (`runtime/manifest.schema.json`): name, description, version,
  author, state slots, signals in/out, shapes used, fact ids depended on.
- Update `behaviors/host.ts` and the smoke test allow-list. Document every call
  in one paragraph each in `docs/HOST_API.md`; the design agent's prompt is built
  from that file, so its clarity is the model's success rate.
- Tests: a hand-written module using only generic calls builds a weather station
  (two shapes, two state slots, one signal) and runs.

### W1. Workshop server
`generate.py` becomes a service.
- `workshop/` Node (TypeScript) server with one endpoint: POST the conversation,
  get back either questions or `{ manifest, source, wasm, explanation, fact_ids }`.
- System prompt assembled from `docs/HOST_API.md`, the manifest schema, one
  example module, `facts/index.json` (ids, labels, values, tiers, citations) and
  the principles section of `CLAUDE.md`. The model is told: ask before building
  when the request leaves open a choice that facts bear on; cite fact ids; never
  state a Mars number that is not in the index.
- Compile with `asc`, run `test/smoke.mjs`, feed errors back, three tries.
- API key from `process.env.ANTHROPIC_API_KEY` via a gitignored `.env`; add
  `.env.example`; add a CI check that fails if anything resembling a key appears
  in tracked files.
- Tests: a recorded conversation produces a module that passes the smoke test
  (mock the LLM for CI); the retry loop is exercised with a deliberately broken
  first response.

### W2. Workshop panel
- A panel in `web/app.html`: conversation, the model's questions, a confirm
  step, then build / test / load status, then the object placed at the tapped
  location (or beside the rover if none).
- Inspector renders the manifest's state slots and shows the weakest tier of the
  fact ids the module depends on, with the citations from the index.
- Every created object gets the "did you know" line: one fact the model used,
  with its source.
- Works on a phone-width screen (collapsible, like the HUD).

### A1. Acceptance
Run these five prompts from a cold start against the real model. Each must yield
a working object within two tries, and the agent must ask at least one question
grounded in a fact id before building. Record the transcripts under
`workshop/acceptance/` and the pass/fail in the PR.
1. A weather station that logs temperature every hour and raises a red flag when
   it drops below minus 70.
2. A beacon that lights up when any rover is within 20 metres.
3. A solar panel that turns to track the sun and reports its output.
4. A small creature that wanders around and hides behind rocks when the rover
   gets close.
5. A dust gauge that estimates how dirty the panels are from the dust optical depth.
Tune the system prompt until at least four of five pass; report which failed and
why. Do not special-case any prompt in code.

### S1. Deploy to a production site (requested by the owner on 2026-11-11, issue 18)
A URL the owner can open from any device: the packed page and the workshop
server in one container that stops when idle (Fly.io, `Dockerfile`,
`fly.toml`, the day's model-call count on a small volume), the key only in
the host's environment, an access code the player types once, a
throttle on wrong codes, a daily cap on model calls (default 50), Host and
Origin pinned to the deployed site, `/health` saying only ok to strangers, a
Content-Security-Policy on the page that keeps player modules sandboxed, and a
deploy from `main` only after the test job is green. A serverless function was
assessed and does not fit (a request can run for minutes with child processes
and one build queue); the reasons and the measured numbers are in
`docs/DEV_GUIDE.md` §11. The sandbox limits, the manifest schema, `facts/` and
`CLAUDE.md` are untouched. The owner creates the hosting account, sets
`ANTHROPIC_API_KEY`, `WORKSHOP_ACCESS_CODE` and `WORKSHOP_DAILY_CAP` there, and
adds `FLY_API_TOKEN` to the repository secrets.

## Phase D: realism (after the MVP demo, not before)

These are unchanged from version 1 and still matter; they are simply later.
- **H1** Host API exposes live environment from the climate model (MCD series).
- **P1** Primitives library, trimmed to what a greenhouse needs: conduction,
  radiation to sky, PV output, battery balance, degree-day crop. Pure, tested,
  cited.
- **E1** Conservation audit: power and mass ledgers per tick; violators disabled.
- **G1** Greenhouse built from primitives, run through MCD seasons, with the
  acceptance tests from version 1 (freezes with heater off; 2 kW array with no
  storage fails the first night; storm scenario cuts power by the modeled factor).
- **F4** MY37 rerun of the MEDA pipeline when the archive is complete.
- **F2b** Upwind-sensor MEDA air-temperature statistic (select the mast sensor facing the wind from `DER_WS`, as the MEDA papers do) to settle how much of the 11-21 K afternoon gap between MCD and MEDA in `facts/derive/out/mcd_vs_meda_my36.md` is rover heating. Until then the engine treats the MCD diurnal swing as a lower bound.

## Phase E: persistence and multiplayer (later)
Owner and version fields exist from R1 so this does not require a rewrite.

## Supervisor's review checklist

**Provenance (facts PRs)**
- [ ] Every fact has a `source_ids` entry that resolves and the source contains that number (spot-checked by fetching).
- [ ] No tier upgraded beyond what the source supports; derived values recompute (`recompute.mjs`).
- [ ] Nothing approximate remains without an open task or a supersession.

**Sandbox (runtime PRs)**
- [ ] Import allow-list, budget and watchdog still enforced; the runaway test still passes.
- [ ] A module cannot reach another object's shapes, state or memory (test it).
- [ ] Hot-swap leaves no gap and does not disturb other objects.
- [ ] Host API keys appended, never renumbered; `docs/HOST_API.md` updated.

**Workshop (W1/W2 PRs)**
- [ ] The key is read from the environment only; the tracked-files key check runs in CI.
- [ ] The system prompt forbids Mars numbers not in the index and the acceptance transcripts show the model citing fact ids.
- [ ] The retry loop is tested with a broken first response.
- [ ] Nothing in the pipeline special-cases a prompt.

**Intent (every PR)**
- [ ] The player is never told "no"; constraints arrive as questions or consequences.
- [ ] Anything not grounded in a sourced fact is labelled in the inspector.
- [ ] Small PR, honest description, disagreements stated.

When you disagree with this brief, say so in the PR description with the
reason. The supervisor would rather argue than discover a silent workaround.
