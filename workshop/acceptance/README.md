# A1 acceptance transcripts

The five prompts from `facts/AGENT_BRIEF.md` (A1), run from a cold start against the
real model with `npm run acceptance` (one prompt: `-- --prompt N`; scripted player
answers: `-- --answers file.json`, `{ "2": ["first answer", ...] }`). Each run starts a
fresh workshop server (a child process, so the system prompt is rebuilt from the files)
and a new conversation; the player's answers are typed at the terminal.

Every run is written to a new file, `N-<prompt words>-<UTC timestamp>.json`, never
overwriting an earlier run, and even when the run throws (the error is recorded). A
transcript holds the messages as sent, every server answer (manifest, source,
explanation, smoke-test report, tries, the per-try log with each try's source and
manifest text, module bytes and their sha256), the system prompt's sha256 and the model
id from `/health`, the git commit and whether the tree was clean, the fact ids cited in
each question (brackets count; ids written with other punctuation are recorded apart),
and the numbers that appear without a fact id right after them, in the questions, the
explanation, the manifest text and the source comments (a reviewer's aid, not a verdict).
After a declined or failed answer the operator may send one more message in the same
conversation; that turn is recorded too. Nothing is edited after the fact.

Judging is offline and rerunnable: `node test/acceptance/judge.mjs` (also part of
`npm test`) rebuilds each transcript's source with the workshop's compile and smoke test,
requires the rebuilt bytes and the recorded bytes to both hash to the recorded sha256
(otherwise the verdict is "inconsistent"), loads the rebuilt module through the registry
and runs the prompt's behaviour check from `test/acceptance/behaviour.mjs`, and recomputes
from the recorded turns whether a question citing a live fact id came before the build.
A pass needs the check, at most two tries, and that question; an id cited without brackets
is reported for the reviewer. Results are counted per system prompt hash.

## Results

Final set: system prompt `3cc2a5f6…` (sha256 `3cc2a5f65e70` prefix in the transcripts), model
`claude-opus-5-5`, git `f570f5f`, run 2026-11-11 20:21 to 20:30 UTC, the player's answers typed by
the operator. Judged with `node test/acceptance/judge.mjs`; the full evidence is in its output.

| # | Prompt | Transcript | Result | Tries | Fact-grounded question | Behaviour check |
|---|--------|-----------|--------|-------|------------------------|-----------------|
| 1 | weather station | `1-…-20261111T202157Z.json` | **pass** | 1 | yes: threshold vs the measured nightly low, air vs ground, Mars hours (5 ids) | hourly logs; flag up at 5 h and 1.5 h, down at 7.5 h and 14 h |
| 2 | beacon | `2-…-20261111T202338Z.json` | **pass** | 1 | yes: power through the night, visibility through dust (5 ids) | lit at 19 and 15 m, dark at 21 and 30 m, brighter and a slot at 1 |
| 3 | solar panel | `3-…-20261111T202557Z.json` | **fail** (reviewer's ruling) | 2 | yes: which season's sunlight, dust, one axis or two (9 ids) | output 196 W at noon, 0 at midnight, exact for its stated model; but the panel's face never points at the sun. It poses yaw at a quarter turn and sweeps pitch −2.75 → −0.39 rad from 7.5 h to 16.5 h, expecting the turn first and the tilt about its own turned axis; on the page yaw is applied before pitch about the object's x, so the panel stands on edge facing sideways and rotates in its own plane. `docs/HOST_API.md` does not state the order. |
| 4 | creature | `4-…-20261111T202836Z.json` | **pass** | 1 | yes: surviving the night, what it runs on (6 ids) | wanders, reacts to the rover, stops after 7 s with a rock 0.05 m off the line in 10 of 10 samples; control not occluded |
| 5 | dust gauge | `5-…-20261111T203017Z.json` | **pass** | 1 | yes: haze vs grime, which record, dust devils (3 ids) | grime cover ×4.00 when the tau fact is raised fourfold; the haze slot is a labelled copy of tau |

Prompt 1 is reported apart from 2 to 5 because the weather station is also the one example in the
system prompt: 3 of 4 among prompts 2 to 5 built a working object within two tries after a
fact-grounded question; prompt 1 passed as well; 4 of 5 overall, which meets the brief's bar.
Prompt 3 is the reviewer's ruling, for a reason the judge's checks do not name: everything else
about the run is good (the question, the player's choices honoured, the dust model and sun path
labelled as assumptions, the output arithmetic exact), but what the page shows is not a tracker.
The cause is a gap in the host documentation, not in the module, and it is not fixed in this
branch because a change to `docs/HOST_API.md` changes the system prompt hash and would unfreeze
the set.

Prompt 3's first try failed the manifest check (a state entry outside the schema), not the build;
the second try passed. No run hit a 422 or a `failed`.

Earlier attempts, kept as recorded:

- `…T200842Z` (prompt 1) and `…T200959Z` (prompt 2), system prompt `9c0a54d2…` at git `4eb4844`:
  both built in one try without asking a question, which the brief counts as a fail. The prompt
  was then tuned to always ask once before the first build.
- `…T201229Z` (prompt 1) and `…T201416Z` (prompt 2), the tuned prompt as an uncommitted edit on
  top of git `4eb4844` (the prompt committed at `4eb4844` hashes to `9c0a54d2…`; these transcripts
  carry `3cc2a5f6…` with `git_clean` false for that reason): both pass.
- `…T201938Z` (prompt 3), the same uncommitted edit on top of `4eb4844`: the model's build reply was cut off
  at the 16000-token output limit (its thinking counts against it), recorded as `error 502`. The
  operator sent one more message in the same conversation and the panel was built in one try on
  that turn (the stale error turn did not hurt). The limit was raised to 32000 in `workshop/llm.mts`
  (git `f570f5f`) and all five prompts were run again from a cold start on that commit.

`git_clean` is false in the final transcripts because the earlier transcripts were untracked in
the working tree at run time; the code at `f570f5f` was clean.

The player's answers were typed by the operator, who knew the checks. Two say more than a player
likely would ("Keep the module compact." in prompt 3, after the earlier cut-off, and "get a rock
between itself and the rover and stay put behind it until the rover goes away" in prompt 4). Both
answer what the agent asked, so the runs stand, but the evidence is weaker than with a blind
player. The transcript's `model` is the configured one; the response's own model id is not
recorded per turn, so a fallback model could have answered a turn unnoticed. Future runs should
record it.

The number scanner flags numbers whose fact id precedes rather than follows them (for example
"[id]. That curve runs from about 195 K…"), the player's own numbers (−70 C, 20 m, 25 %), the
page's 240 s sol, and the kelvin offset; the reviewer reads every transcript in full.
