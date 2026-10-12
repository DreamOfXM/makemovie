#!/usr/bin/env node
/**
 * MakeMovie — the manual is the command.
 *
 * With no arguments this prints the whole of MakeMovie in about a thousand
 * words: what it is, how to run it with no API key, how to run it for real, how
 * to finish the cut in an editor, and the rules for an agent working in a file
 * a human may also be editing. A single argument prints one section.
 *
 * This file is deliberately dependency-free, makes no network call, and writes
 * nothing to disk. It exists so that a person or an agent can learn the project
 * from one command instead of being pointed at a README.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ORDER = ['about', 'try', 'run', 'export', 'agent', 'docs'];

const SECTIONS = {
  about: `
MakeMovie — from a piece of source writing to an audited, delivered master.

  One pipeline, self-hostable, serving short dramas, series and films:

    source audit -> script -> assets -> storyboards -> first frames ->
    videos -> voice & score -> composition -> acceptance -> delivery

  Every step is viewable, editable, and traceable to the model run that produced
  it. A human approval is the checkpoint between spending and shipping.

  What you hold at the end: the episode master, a subtitle track, and a delivery
  manifest — plus an edit list, so the cut is yours to finish (see: makemovie
  export).

  Commands:  makemovie            this manual
             makemovie export     finishing the cut in an editor
             makemovie mock       running the whole chain with no API key
             makemovie agent      rules for an agent in a human's file
             makemovie docs       the documentation map
`,

  try: `
RUN IT WITH NO API KEY

  Requirements: Docker, and this repository. Nothing is billed.

    git clone https://github.com/DreamOfXM/makemovie.git && cd makemovie
    cp .env.example .env
    docker compose --profile full up -d --build     # then open http://localhost:3010

  In Model center, connect the bundled mock provider and bind a mock-* model to
  each of the four required slots:

    script_text    storyboard_text    image_gen    video_t2v

  Every stage then completes with synthetic output. mock-tts and mock-music
  synthesise audible tones wherever FFmpeg is installed, so the voice, score and
  subtitle chain can be walked end to end, offline.

  The mock provider is a test double, not a demo: the repository ships no sample
  media and no seeded content. Nothing is pre-baked — you watch the chain build
  an episode from nothing.
`,

  run: `
RUN IT FOR REAL

  1. Model center -> add a provider connection. Credentials are encrypted at
     rest with STUDIO_MASTER_KEY and are never returned by the API. A single
     Alibaba Cloud Bailian / DashScope connection covers all four required
     slots. OpenAI, Google and Anthropic are wired from published vendor
     documentation and covered by contract tests — contract-tested, not
     account-verified.
  2. Run Probe on the connection, then Verify this model on any chat-family row.
     Bind a verified model to each required slot; Resolve candidates shows the
     ordered fallback list the pipeline will use.
  3. Create a project. Pick its shape — short drama, series or film — its
     content language and its style preset.
  4. Sources & scripts: paste or upload the source text, then Approve. Approving
     queues the script stage by itself; that is as far as automation goes
     without you.
  5. Read the generated script, correct it in place if needed, Approve it. The
     breakdown and the cast / props / scenes extraction follow; the Workbench
     fills with one card per shot.
  6. Release the spending one stage at a time: approve the reference images,
     generate first frames, clips, voices for the shots that speak, the score,
     then Compose the episode. Each button says how many tasks it is about to
     queue before you confirm.
  7. Review shot by shot, then in Deliveries package the episode. Packaging is
     refused with reasons until composition has finished and every live shot has
     a succeeded clip.

  Triggering a stage twice returns the existing batch instead of queueing
  duplicate work; Regenerate is the deliberate way to re-run a stage after
  editing its upstream.
`,

  export: `
FINISH IN YOUR EDITOR

  A delivery is not a dead end. Alongside the master, the subtitle track and the
  manifest, every delivery builds two edit lists from the same shot manifest:

    EDL        the cut, for any editor that reads an edit decision list
    FCP XML    the timeline, for Premiere Pro and DaVinci Resolve

  So the choice is yours: accept the pipeline's cut, or take that same cut into a
  real editor and finish it by hand. The shot manifest stays the source of truth —
  the edit lists are derived from it, never the other way round.
`,

  agent: `
IF YOU ARE AN AGENT

  You may be working in a file a human is also editing. Four rules keep that from
  turning into a collision:

    1. Read before you write, and change only what you mean to change.
    2. A track the human has locked is off-limits — do not touch it, do not
       unlock it.
    3. Edits the human made in their own editor are theirs; keep them as they
       are.
    4. Address everything by a stable id, never by position or order.

  Full text: AGENT-EDITING.md. The production methodology the pipeline encodes is
  docs/skills/film-production/SKILL.md.
`,

  docs: `
DOCUMENTATION

  README.md      what it is, features, quick start
  README.zh-CN.md   the same, in Chinese
  ARCHITECTURE.md   domain model, capability policy, state machine, orchestration,
                    queue design, quality gates, storage, security
  CONTRIBUTING.md   development workflow, testing, pull-request checklist
  AGENT-EDITING.md  concurrency rules for an agent in a human's file
  skills/makemovie/SKILL.md
                    the one-command entry point for coding agents
  docs/skills/film-production/SKILL.md
                    the production methodology the pipeline encodes
`,
};

const ALIASES = {
  about: 'about',
  help: 'all',
  h: 'all',
  all: 'all',
  docs: 'docs',
  doc: 'docs',
  mock: 'try',
  try: 'try',
  'no-key': 'try',
  run: 'run',
  start: 'run',
  export: 'export',
  editor: 'export',
  edl: 'export',
  agent: 'agent',
  agents: 'agent',
};

function version() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0-source';
  } catch {
    return '0.0.0-source';
  }
}

function main() {
  const raw = process.argv[2];
  const key = raw ? raw.replace(/^--?/, '').toLowerCase() : 'all';

  if (key === 'version' || key === 'v') {
    process.stdout.write('makemovie ' + version() + '\n');
    return;
  }

  const target = ALIASES[key];

  if (target === 'all') {
    const body = ORDER.map((name) => SECTIONS[name]).join('');
    process.stdout.write(`${body}\nLearn more: https://github.com/DreamOfXM/makemovie\n`);
    return;
  }

  if (target) {
    process.stdout.write(`${SECTIONS[target]}\n`);
    return;
  }

  process.stdout.write(
    `Unknown command: ${raw}\n\n` +
      `Commands: about, run, mock, export, agent, docs, version\n` +
      `Run makemovie with no arguments for the whole manual.\n`,
  );
}

main();
