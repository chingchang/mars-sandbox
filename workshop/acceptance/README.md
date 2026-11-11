# A1 acceptance transcripts

The five prompts from `facts/AGENT_BRIEF.md` (A1), run from a cold start against the
real model with `npm run acceptance` (one prompt: `-- --prompt N`; scripted player
answers: `-- --answers file.json`). Each run starts a fresh workshop server and a new
conversation; the player's answers are typed at the terminal. A transcript records the
messages as sent, every server answer (manifest, source, explanation, smoke-test report,
tries, per-try log, module bytes and their hash), the system prompt's hash and the model
id from `/health`, the fact ids cited in the agent's questions, and any Mars number that
appears without a fact id nearby. Nothing is edited after the fact.

Behaviour is judged offline by `test/acceptance/behaviour.mjs` (the real registry and
worker, synthetic sensors), one check per prompt; `npm test` runs those checks against
the samples and fixtures so the checks themselves are tested.

## Results

Not run yet: this machine has no `ANTHROPIC_API_KEY`. The table below is filled in
once the runs exist.

| # | Prompt | Result | Tries | Fact-grounded question | Behaviour check |
|---|--------|--------|-------|------------------------|-----------------|
| 1 | weather station | not run | | | |
| 2 | beacon | not run | | | |
| 3 | solar panel | not run | | | |
| 4 | creature | not run | | | |
| 5 | dust gauge | not run | | | |
