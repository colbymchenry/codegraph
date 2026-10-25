# CLAUDE.md

Claude Code project guidance for this repository.

Primary instructions live in the canonical agent guide — import it:

@AGENTS.md

## Claude-only notes

- Repo guidance is split: `AGENTS.md` carries the rules an agent can break without noticing, and `.claude/skills/<name>/SKILL.md` carries each task-specific procedure (Claude Code loads these as skills automatically). Edit the matching file — not this wrapper — when guidance changes.
- Claude Code can `@`-import nested guides too (e.g. `@docs/AGENTS.md`) when working on design/eval docs; Codex loads nested `AGENTS.md` automatically when the session cwd is under that directory, but it does not load `.claude/skills/` — the Skills section in `AGENTS.md` is its index.
- Do not reintroduce a duplicated `## CodeGraph` MCP tool-guidance block here — `src/mcp/server-instructions.ts` is the single source of truth (issue #529); the installer strips legacy marker blocks on upgrade.
