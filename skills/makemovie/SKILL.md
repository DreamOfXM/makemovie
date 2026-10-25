---
name: makemovie
description: Operate a self-hosted MakeMovie installation — source text through screenplay, breakdown, reference images, first frames, clips, voice-over, score, subtitles and an audited episode master, plus an EDL / FCP XML edit list for Premiere Pro and DaVinci Resolve. Use when the task is bringing a MakeMovie stack up, binding models, approving stage by stage, reviewing shots, or packaging a delivery. Triggers: makemovie, MakeMovie, 影视生产, 分镜, 短剧, 母版, 剪辑交付, EDL, FCP XML.
license: Apache-2.0
---

# MakeMovie

A self-hosted pipeline that turns a piece of source writing into an audited,
delivered master. Every stage is viewable, editable, and traceable to the model
run that produced it. A human approval sits between spending and shipping — that
is the design, not a limitation to route around.

This skill is how you operate an installation. The production methodology the
pipeline encodes lives in the sibling skill `film-production`; read it before
making content decisions.

## What you hold at the end

The episode master, a subtitle track, a delivery manifest, and two edit lists
built from the same shot manifest: an EDL for any editor that reads one, and an
FCP XML timeline for Premiere Pro and DaVinci Resolve. The pipeline's cut is
yours to accept or to finish by hand.

## Bring it up

No API key, nothing billed:

    git clone https://github.com/DreamOfXM/makemovie.git
    cd makemovie && cp .env.example .env
    docker compose --profile full up -d --build     # http://localhost:3010

In Model center connect the bundled mock provider and bind a `mock-*` model to
each required slot — `script_text`, `storyboard_text`, `image_gen`, `video_t2v`.
Every stage then completes with synthetic output. The mock provider is a test
double: the repository ships no sample media and no seeded content.

For real work, connect one provider (a single Alibaba Cloud Bailian / DashScope
connection covers all four slots), run Probe on the connection, Verify a model on
any chat-family row, then bind a verified model to each required slot. Resolve
candidates shows the ordered fallback list the pipeline will use.

## Drive it stage by stage

1. Create a project: its shape (short drama, series or film), content language
   and style preset. The style preset governs reference images as well as shots.
2. Sources & scripts: paste or upload the source text, then Approve. Approving
   queues the script stage by itself; automation stops there.
3. Read the generated script, correct it in place, Approve it. Breakdown and the
   cast / props / scenes extraction follow; the Workbench fills with one card per
   shot.
4. Release spending one stage at a time: approve the reference images, generate
   first frames, clips, voices for the shots that speak, the score, then Compose
   the episode. Every button states how many tasks it is about to queue before
   you confirm.
5. Review shot by shot. Then, in Deliveries, package the episode. Packaging is
   refused with reasons until composition has finished and every live shot has a
   succeeded clip.

Triggering a stage twice returns the existing batch instead of queueing duplicate
work. Regenerate is the deliberate way to re-run a stage after editing its
upstream.

## Rules that keep a run honest

- The source writing is the only source of truth for plot. Do not add, reorder or
  foreshadow events that are not in it.
- Validate a stage's input before executing it. If it fails, mark it `blocked`,
  record the reason and stop. Never retry silently, never swap model or provider
  to get past a failure, never rewrite plot to make a check pass.
- Do not start the next batch or compose the episode while the current batch is
  unconfirmed.
- One authorised model per batch. "Enabled" or "has quota" in a console is not
  proof the key works — probe the real endpoint before the batch starts.
- Report stages separately: planned, first frames done, clips done, composed.
  Never present a partial cut as a finished chapter.
- Never delete or overwrite a previous version to "fix" a shot. Record a new
  version and mark it current.

## Working in a file a human also edits

1. Read before you write, and change only what you mean to change.
2. A locked track, shot or field is off-limits — do not touch it, do not unlock it.
3. Human edits outrank anything derived; keep overrides exactly as they are.
4. Address everything by stable id, never by position or order.

Full text: https://github.com/DreamOfXM/makemovie/blob/main/AGENT-EDITING.md

## Where things are

- Repository, issues and releases: https://github.com/DreamOfXM/makemovie
- Product page: https://dreamofxm.github.io/makemovie/
- Architecture: https://github.com/DreamOfXM/makemovie/blob/main/ARCHITECTURE.md
- Production methodology (sibling skill): `film-production`
- The terminal manual, printable on any machine with Node: `npx -y makemovie@latest`
