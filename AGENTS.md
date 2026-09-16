# short-drama-studio — agent instructions

Monorepo: `apps/api` (Fastify) · `apps/web` (Next.js + Tailwind) · `apps/worker` (BullMQ) ·
`packages/*` (domain / db / providers / media / config). Spec: `ARCHITECTURE.md`.
Short-drama production rules: `docs/skills/short-drama-production/SKILL.md`.

## UI work pipeline (`apps/web`) — mandatory, no need to ask

Any task that creates or changes visible UI MUST run this pipeline in order.
Routing is fixed — never ask the user which design skill to use.

1. **System first — `ui-ux-pro-max`.**
   - If `design-system/makemovie/MASTER.md` exists: read it, obey it. Page override in
     `design-system/makemovie/pages/<page>.md` wins over MASTER when present.
   - If it does not exist: generate it first —
     `python .agents/skills/ui-ux-pro-max/scripts/search.py "<product> <industry> <keywords>" --design-system --persist -p "MakeMovie" --output-dir "."`
     then follow it. Never silently discard an existing MASTER.md.
2. **Build** the UI per that system (stack: Next.js + Tailwind, `--stack nextjs`/`shadcn`
   guidance applies). Colors/fonts/spacing only via tokens — no raw hex in components.
3. **Distinctiveness pass — `hallmark`.**
   - New page: default design flow (pick macrostructure + theme, state the picks, run slop test).
   - Touched existing UI: `hallmark audit <files>` first, fix the punch list.
   - Never ship two consecutive pages with the same macrostructure/nav pattern.
4. **Taste baseline — `frontend-design`.** Final self-check: no purple-gradient-on-white
   default, no system-font-only typography, no identical rounded-card-kit everywhere,
   one memorable element per page, rest disciplined.

Hard bans (any step): system-font-only type scale · default purple accent
(`oklch(0.54 0.21 292)` family) without a brief · emoji as icons · `transition: all` ·
icon-only buttons without `aria-label` · missing empty/loading/error states.
