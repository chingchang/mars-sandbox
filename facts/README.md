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
| `defined`    | Exact by convention (the astronomical unit, SI-defined constants)         | Only when the convention changes; cite the resolution |
| `measured`   | Directly observed in situ or from orbit by a named instrument            | Only with a new measurement; old value kept in history |
| `derived`    | Computed from measured values with stated formula (e.g. solar constant)  | When inputs change |
| `modeled`    | Output of a published model or reanalysis (climate DB, heat-flow models) | When a newer model version is adopted |
| `hypothesis` | Published but contested or indirectly inferred (deep crustal water)      | Freely; competing versions may coexist |
| `engineering`| Demonstrated technology performance (MOXIE output, crop trials)          | With new demonstrations |
| `assumption` | Player or scenario choice ("assume perchlorate remediation solved")      | Player-owned; never in this folder |

### Tier ordering

Tiers are ranked, strongest evidence first:

    defined > measured > derived > engineering > modeled > hypothesis

Rationale: `defined` outranks everything because a value fixed by convention
cannot be contradicted by a better instrument; it is for exact constants, not
for anything about Mars. Below that, a design that depends on a demonstrated technology is making an
evidential claim too, so `engineering` is ranked rather than kept as a separate
axis. A flight demonstration (MOXIE on Mars) is stronger evidence than a model
output, because it happened, but weaker than a measurement of Mars itself,
because it tells you what a machine did, not what Mars is. `derived` sits
directly under `measured` because it is a stated formula applied to measured
inputs and nothing else.

Two rules follow from the ordering:

1. A record may not claim a tier stronger than any record in its `depends_on`.
   A formula applied to a `modeled` input yields a `modeled` record, not a
   `derived` one, even though it carries `formula` and `depends_on`.
   `validate.mjs` enforces this.
2. A module may depend on any tier, but the UI must show the weakest tier it
   depends on. A greenhouse built on `measured` temperature and `hypothesis`
   deep water is a `hypothesis`-grade design, and the player should see that.
   `index.json` carries `tier_order` and a `tier_rank` per fact so clients and
   the host API (task H1) can compute this without hard-coding the order.

## Files

- `schema.json`           JSON Schema every fact record must validate against
- `validate.mjs`          Validator and index builder (`npm run facts`); CI runs `npm run facts:check`
- `index.json`            Generated: id -> record map, bundle versions, source citations, content hash. Do not edit; commit the regenerated file
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

## Formulas

A `formula` is prose for the reviewer to recompute, but it may not smuggle in
numbers. Every numeric literal in a formula must be the `value` of a record in
`depends_on` (reference it by id instead), a small integer from 0 to 10
(exponents, coefficients), or one of the explicit unit-conversion constants
`86400`, `1000`, `pi`. Anything else fails validation: an unsourced number
inside `facts/` is exactly the silent assumption `CLAUDE.md` rules out. If a
formula needs a physical constant, add it as a record with a source (see
`sun.solar_constant_1au`, `astro.au`).

## index.json

Generated by `validate.mjs`; deterministic (packages in the order given, bundles
in filename order, facts in file order, no timestamps). Top level:

| field          | contents |
|----------------|----------|
| `content_hash` | sha256 of the canonical content below. A world stores this to pin the facts it was created against |
| `tier_order`   | the tier ranking above, strongest first |
| `packages`     | package name -> `{ root, bundles[] }`; `root` is relative to the base package |
| `bundles`      | bundle name -> `{ file, package, version, description, fact_count }` |
| `ids`          | every fact id in index order. Append-only: task H1 derives host keys from positions |
| `facts`        | id -> the record as written, plus `bundle`, `package`, `tier_rank` (position in `tier_order`) |
| `sources`      | source id -> `{ citation, urls[], use[], verified, reference_only, cited_by[] }` |

Per source, `citation` is the first line under its heading in `sources.md`,
`urls` every URL in the entry, `use` the bold codes on its `Use:` line (`F` fact,
`D` data archive, `R` design reference), `verified` the last "Verified
YYYY-MM-DD" date, `reference_only` whether it may not be cited by a fact, and
`cited_by` the facts that cite it. This is what the inspector's "did you know"
and the design agent read to attribute a number.

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
`validate.mjs --dir facts --dir <package>` validates the base package and a
contribution together: ids must be unique across packages, `depends_on` may
cross packages, each package brings its own `sources.md`, and the index records
which package each fact came from. (Checking `provides` / `depends_on` declared
in `package.json` against the records is not implemented yet.)
Contributions to `measured` require an instrument and a primary source;
`modeled` requires the model name and version; `hypothesis` requires the paper.
The maintainer (currently the supervisor agent) reviews against `AGENT_BRIEF.md`.

## What is deliberately NOT here

- Physics equations. Those belong in the vetted primitives library, not the fact base.
- Anything about crewed-mission architectures as fact. DRA 5.0, Mars Direct and
  SpaceX plans are *designs*, referenced in `sources.md` for the agent to learn from.
- Numbers from popular articles when the primary paper is available.
