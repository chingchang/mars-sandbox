# Mars Sandbox: what we are building and why

Read this before any task in this repo. It is the intention behind every design
decision; when the brief in `facts/AGENT_BRIEF.md` and this file seem to pull in
different directions, this file wins and you say so in the PR.

## The one-sentence version

Mars Sandbox is an educational game first: a shared, persistent, scientifically
grounded Mars where players invent things in natural language, and every
invention is an opportunity to learn something true about Mars, physics,
engineering or biology, through play rather than instruction.

## Principle 1: Educate through play, never by blocking

Players will want things that are not realistic. An alien race at war with the
human Martians. A dragon. A city under a glass dome built in a week. We do not
say no. We say "yes, and here is what that would take," and we make the
constraints interesting.

The pattern is: accept the fantasy, ground it in the facts we have, push back on
the details, and let the player decide. Example, an alien race:

- Accept it. Aliens exist in this world now.
- Ground it. What would a body need to be viable on Mars and in space? Thin
  CO2 atmosphere, 0.38 g, 0.7 mSv/day radiation, 60 K daily temperature swings,
  perchlorate in the soil. Facts, with sources, from `facts/`.
- Push back on the details, as questions, not vetoes. Carbon-based or not, and
  what chemistry would work in that cold? Large bodies lose heat slowly but need
  more food; small ones are cheap to feed but freeze. Why would they look like
  humans, or reptiles, or fish? What does a fish-like shape buy you when there is
  no liquid water at the surface? Could they have evolved in the deep crustal
  water (a real hypothesis in `facts/hypotheses.md`) and what would that imply
  about eyes, pressure tolerance, metabolism?
- Let the player choose. Their answer becomes a labelled assumption in their
  world. The world stays consistent with it from then on.

The game is semi-fictional and semi-factual on purpose. Fantasy supplies the
motivation; facts supply the friction; the friction is where learning happens.
A player who argues with the game about whether their aliens can breathe CO2
has learned more atmospheric chemistry than any lesson would teach.

Concretely, every generated object or capability should surface at least one
"did you know" that is tied to a fact id and its source, and every hypothesis
or assumption it rests on should be visible in the inspector. The tier system
in `facts/README.md` exists so the game can always tell the player how much of
what they are looking at is real.

## Principle 2: Multiplayer, collaborative, player-driven

Think of it as a simulated Burning Man on Mars. A shared world where people
build next to each other, borrow each other's components, form camps, run
experiments together, and create experiences for other players. The memorable
things should be made by players, not by us.

What we own: the base layer. The planet, its facts and laws, the simulation
engine, the component and capability system, the sandboxing, persistence,
versioning, and the review process that keeps the fact base honest. This is the
infrastructure, and it has to be solid, fair and boring.

What players own: everything on top. Objects, machines, structures, behaviors,
stories, factions, aliens, events, camps, art. The game is only as good as what
players can build, so every architectural choice should be judged by one
question: does this make it easier for players to create things other players
want to experience?

Design consequences:

- Multiplayer is not a later feature; it shapes the data model now. Every object
  has an owner, a version, and permissions. Worlds have collaborators. Components
  are shareable independently of worlds. Changes are commits that can conflict
  and merge. Build single-player as the one-collaborator case of this, not the
  other way round.
- Player-created content is untrusted by default and runs sandboxed; that is a
  safety property, not a statement of distrust. Make the review and publish path
  fast and legible so sharing feels rewarding.
- The fact base is extensible by third parties through the same mechanism players
  use, with provenance review. A university lab contributing a crop model is a
  player too.
- The AI design agent is a collaborator in the workshop, not an oracle. It asks,
  proposes, cites and explains. It never fabricates a number; it reads from
  `facts/` through the host API like any module.

## What this rules out

- Realism as a gate. "That's not possible" is never the end of a conversation.
- Lectures. Learning is delivered as questions, constraints and consequences in
  the world, not as text walls.
- Developer-authored content as the main attraction. We build tools and laws.
- Silent assumptions. Anything not grounded in a sourced fact is labelled.

## Where things live

- `facts/`: the knowledge layer, tiers, sources, open hypotheses, and the agent
  brief with the supervisor's review checklist.
- `behaviors/host.ts`: the host API, the only surface a player module can touch.
- `sim/primitives/`: vetted physics as pure functions (to be built).
- `web/`: the Three.js client and the sandboxed worker host.
- `test/`: the tests that must keep passing. Add one for every new capability.

Working conventions, enforced in review: no number about Mars without a source
id; never raise a provenance tier beyond what the source supports; physics in
primitives, facts in facts; conservation audited every tick; small PRs with a
description of what was built, how it was tested, what sources were added, and
anything you disagreed with here and why.
