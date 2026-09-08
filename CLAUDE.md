<!-- SPECTRA:START v1.0.2 -->

# Spectra Instructions

This project uses Spectra for Spec-Driven Development(SDD). Specs live in `openspec/specs/`, change proposals in `openspec/changes/`.

## Use `/spectra-*` skills when

- A discussion needs structure before coding → `/spectra-discuss`
- User wants to plan, propose, or design a change → `/spectra-propose`
- Tasks are ready to implement → `/spectra-apply`
- There's an in-progress change to continue → `/spectra-ingest`
- User asks about specs or how something works → `/spectra-ask`
- Implementation is done → `/spectra-archive`
- Commit only files related to a specific change → `/spectra-commit`

## Workflow

discuss? → propose → apply ⇄ ingest → archive

- `discuss` is optional — skip if requirements are clear
- Requirements change mid-work? Plan mode → `ingest` → resume `apply`

## Parked Changes

Changes can be parked（暫存）— temporarily moved out of `openspec/changes/`. Parked changes won't appear in `spectra list` but can be found with `spectra list --parked`. To restore: `spectra unpark <name>`. The `/spectra-apply` and `/spectra-ingest` skills handle parked changes automatically.

<!-- SPECTRA:END -->

# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See <https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md> for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:

   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```

5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**

- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

## Build & Test

```bash
npm ci
npm test                  # node --test && vitest (components)
npm run test:cloud        # miniflare-based cloud worker tests
```

`test/inject-fullheight-regression.test.mjs` spawns real headless Chrome and has been observed to fail once under full-suite concurrency while passing in isolation. Treat a lone failure there as flaky before treating it as a regression — rerun the file alone (`node --test test/inject-fullheight-regression.test.mjs`) and rerun the full suite once before concluding the baseline is red.

## Linear Sync (Beads ↔ Linear)

Beads is the execution SSOT. Linear project `dashi-taskboard · Hard Fork Delivery` (Mebase team, `linear.team_id` / `linear.project_id` set via `bd config`) mirrors it for portfolio view. Conflicts resolve in favor of Beads (`--prefer-local`).

- `LINEAR_API_KEY` MUST be an environment variable, never `bd config set linear.api_key` — `.beads/config.yaml` is git-tracked by default and this repo's fork gets pushed to a public remote.
- `bd linear sync --push` (batch mode) has been observed to report every issue as `skipped` (see `--json` output: `"skipped": N`) even with `linear.state_map.*` and `linear.priority_map.*` configured. Root cause not yet identified.
- **Workaround:** push explicitly by ID instead — `bd linear push <id> [<id>...]`. This has worked reliably. Re-test batch `sync --push`/`sync --pull` before relying on them; if the skip persists, keep using per-ID push.
- `bd linear status` shows current link state (`With Linear` vs `Local Only`) without making changes.

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_

## Herdr Resident-PM Orchestration (bootstrapped 2026-09-08)

This repo runs the herdr skill's resident-PM orchestration workflow (`~/.claude/skills/herdr/`), `software-engineering` domain pack. Facts a repo-native session (no skill load) needs to discover this without re-reading the skill:

- **Evidence branch**: orphan branch `agents/evidence`, mounted as a git worktree at `.spectra/blackboard/` (sibling to the worktree root, not inside any Spectra change worktree). `memory/` is the only tier committed to that branch; `board.json`, `orchestrator/`, `pm/`, `changes/`, `deliverables/`, `requests/`, `templates/` are gitignored working state (blackboard's own `.spectra/blackboard/.gitignore`).
- **Push allowlist / remote**: no push-relay hook installed yet (evidence-branch-bootstrap.md §2 is optional and was deferred at bootstrap time — commits on `agents/evidence` are local-only until that hook is added). `origin` is `https://github.com/sarimjang/dashi-taskboard.git`; `upstream` (read-only) is `https://github.com/chuspeeism/dashi-taskboard.git`.
- **`core.hooksPath`**: already redirected to `.beads/hooks` by beads. Any future push-relay hook install must target that directory, not `.git/hooks`.
- **Canonical test command**: `npm ci && npm test` (see Build & Test above); `npm run test:cloud` for the miniflare-backed cloud worker suite.
- **Pane layout**: not yet established — no orchestrator/PM pane has been spawned as of bootstrap. Follow `references/pane-layout.md` (3-pane main console: orchestrator/pm-board/watchdog; per-change quad tabs) when panes are opened.
- **Resident PM identity**: agent name `dashi-taskboard-pm` (project slug `dashi-taskboard` per B3 naming: `<project-slug>-pm`).
- **Session-init manifest (recorded)**: resident-pm → `{kind: claude, model: sonnet, permission_mode: bypassPermissions}`. See `.spectra/blackboard/orchestrator/decisions.jsonl` for the actual `decision: manifest` record — this file only summarizes it for discoverability, the JSONL record is the source of truth.
- **Open judgment call (not explicit in `pm-blackboard-contract.md` B2)**: `requests/` was placed in the gitignored tier, grouped with `pm/`/`changes/`/`deliverables/` per B3's ownership language, since B2's committed/gitignored split does not mention it explicitly either way. Flagged to the skill's feedback inbox as a doc gap.
