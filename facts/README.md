# facts/ — the Mars knowledge layer

This folder is the canonical source of truth the simulation reads from. Every
number the engine, the host API, or an LLM-generated module uses about Mars
must come from here, never from a model's memory.

## Why it exists

Mars Sandbox's product thesis: a scientifically grounded world that players and
third parties can build on. That only works if the facts are (a) sourced,
(b) tiered by how well we know them, and (c) impossible to overwrite silently.
This folder is that foundation. The game engine is a consumer of it; so is the
AI design agent; so will be any third-party module.

## Provenance tiers

Every fact carries exactly one `tier`:

| tier         | meaning                                                                  | may change? |
|--------------|--------------------------------------------------------------------------|-------------|
| `measured`   | Directly observed in situ or from orbit by a named instrument            | Only with a new measurement; old value kept in history |
| `derived`    | Computed from measured values with stated formula (e.g. solar constant)  | When inputs change |
| `modeled`    | Output of a published model or reanalysis (climate DB, heat-flow models) | When a newer model version is adopted |
| `hypothesis` | Published but contested or indirectly inferred (deep crustal water)      | Freely; competing versions may coexist |
| `engineering`| Demonstrated technology performance (MOXIE output, crop trials)          | With new demonstrations |
| `assumption` | Player or scenario choice ("assume perchlorate remediation solved")      | Player-owned; never in this folder |

Rule: a module may depend on any tier, but the UI must show the lowest tier it
depends on. A greenhouse built on `measured` temperature and `hypothesis` deep
water is a `hypothesis`-grade design, and the player should see that.

## Files

- `schema.json`           JSON Schema every fact record must validate against
- `validate.mjs`          Validator and index builder (`npm run facts`); CI runs `npm run facts:check`
- `index.json`            Generated flat id -> record map plus bundle versions. Do not edit; commit the regenerated file
- `constants.json`        Planet-wide constants (gravity, sol, orbit, atmosphere composition)
- `jezero.json`           Site-specific environment for Jezero crater (the v0.1 region)
- `resources.json`        ISRU, water, regolith, agriculture: what has actually been demonstrated
- `sources.md`            Annotated bibliography with URLs; every `source_id` in the JSON resolves here
- `hypotheses.md`         Open questions and competing hypotheses, written for humans
- `AGENT_BRIEF.md`        Instructions for the coding agent, plus the supervisor's review checklist

## Fact record format

```json
{
  "id": "jezero.surface_pressure.mean",
  "value": 718,
  "unit": "Pa",
  "uncertainty": { "type": "range", "low": 640, "high": 780, "note": "seasonal + diurnal envelope, MEDA year 1" },
  "tier": "measured",
  "source_ids": ["meda-2023-naturegeo", "meda-first-report-2021"],
  "instrument": "Perseverance MEDA pressure sensor",
  "valid_for": { "site": "jezero", "lat": 18.44, "lon_e": 77.45 },
  "as_of": "2023-01",
  "notes": "First-sol reading 718 Pa; seasonal CO2 cycle moves it ~±60 Pa."
}
```

Field rules:
- `id` is dot-namespaced and stable forever. Renaming = new id + `superseded_by` on the old one.
- `value` is always SI unless `unit` says otherwise. Temperatures in kelvin; a `display_unit` may say "°C".
- `uncertainty` is required. If a source gives none, write `{"type":"unstated"}` and say so in `notes`.
- `source_ids` must resolve to headings in `sources.md`. No orphan sources, no "common knowledge".
- `as_of` is the date of the source, not the date you wrote the record.
- Never store a number you cannot point at. If you remember it and cannot find it, leave it out and open an issue.

## How the engine consumes this

1. `validate.mjs` validates every `*.json` against `schema.json`, checks every `source_ids` entry
   resolves to a fact source in `sources.md` (design references marked (R) may not be cited),
   checks `depends_on` / `superseded_by` / `competing_with` resolve and are acyclic, and requires
   `derived` records to carry a `formula`. Any violation fails the build. It emits `index.json`,
   and CI fails if the committed `index.json` is stale.
2. The host API exposes facts to Wasm modules by integer key; a generated table maps key → fact id.
   Modules therefore cannot invent an atmosphere; they can only `read()` what is here.
3. The world stores the facts bundle version it was created with. A world made on `facts@1.2`
   keeps simulating on `facts@1.2` until the player chooses to migrate.
4. A player assumption is a separate overlay keyed by fact id and lives in the world, not here.
   The UI renders overlaid facts with a visible "assumed" badge.

## How third parties extend this

A contributed package is a folder with the same layout plus a `package.json`
(name, version, authors, license, `depends_on` fact ids, `provides` fact ids).
Contributions to `measured` require an instrument and a primary source;
`modeled` requires the model name and version; `hypothesis` requires the paper.
The maintainer (currently the supervisor agent) reviews against `AGENT_BRIEF.md`.

## What is deliberately NOT here

- Physics equations. Those belong in the vetted primitives library, not the fact base.
- Anything about crewed-mission architectures as fact. DRA 5.0, Mars Direct and
  SpaceX plans are *designs*, referenced in `sources.md` for the agent to learn from.
- Numbers from popular articles when the primary paper is available.
