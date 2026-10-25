# Editing alongside an agent

MakeMovie is a tree that a human and an agent both edit — a person in their editor, a coding agent in its own session. This document is the concurrency contract between them. It is short on purpose: four rules, and what they are for.

## The four rules

**1. Read before you write, and change only what you mean to change.**
Open the file, understand what is already in it, then make the smallest edit that does the job. Do not reformat, reorder, or "clean up" lines you were not asked to touch. An unexplained diff is a review burden and a merge conflict waiting to happen.

**2. A locked track is off-limits.**
If the human has locked something — a track, a shot, a field — do not edit it, and do not unlock it to edit it. A lock is an instruction, not an obstacle. If you believe the lock is wrong, say so in your reply and let the human decide.

**3. The human's edits are theirs.**
When a person changes something in their own editor, that change is stored as an override and outranks anything derived. Keep overrides exactly as they are. Do not regenerate over them, do not normalise them, do not fold them back into a template.

**4. Address by stable id, never by position.**
Identify a shot, a track, a field by its id. Do not assume the third item is the third item: a human may have inserted, reordered, or deleted something while you were thinking.

## Why these four

The point is not politeness. It is that a human's in-flight edit and an agent's batch edit must both survive. Rule 1 and rule 4 keep your change from landing on top of theirs; rule 2 and rule 3 keep their intent from being overwritten by yours.

## The loop

The human edits, the agent reads the current state and continues. The agent edits, the human sees the diff and continues. Neither side needs to announce itself first — the file is the shared channel, and the rules above are what keep it readable from both ends.

## See also

- [CONTRIBUTING.md](./CONTRIBUTING.md) — the development workflow and pull-request checklist
- [skills/film-production/SKILL.md](./skills/film-production/SKILL.md) — the production methodology the pipeline encodes
