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

Not run yet: this machine has no `ANTHROPIC_API_KEY`. The table below is filled in from
the judge's output once the runs exist, naming the set of transcripts (one system prompt
hash) that is the final one.

| # | Prompt | Result | Tries | Fact-grounded question | Behaviour check |
|---|--------|--------|-------|------------------------|-----------------|
| 1 | weather station | not run | | | |
| 2 | beacon | not run | | | |
| 3 | solar panel | not run | | | |
| 4 | creature | not run | | | |
| 5 | dust gauge | not run | | | |
