# Pi Coding Agent Extensions

Custom extensions for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Extension | Description |
|-----------|-------------|
| [highlight-footer](./extensions/highlight-footer.ts) | Custom footer with git status, model name, and gradient context usage bar |
| [compaction-model](./extensions/compaction-model.ts) | Uses a separate smaller model for session compaction and branch summarization |
| [working-indicator](./extensions/working-indicator.ts) | Context-aware working indicator that changes based on what Pi is doing |
| [response-latency](./extensions/response-latency.ts) | Shows response latency with color-coded speed phases |

## Installation

Copy extensions to your Pi extensions directory:

```bash
# Default location
cp extensions/*.ts ~/.pi/agent/extensions/
```

Or enable individually:

```bash
pi --extension /path/to/PiCodingAgentExtensions/extensions/highlight-footer.ts
```

## Configuration

### highlight-footer

No configuration needed. Displays:
- Line 1: project name / git branch with staged/unstaged file counts
- Line 2: model name with gradient context usage bar (green → yellow → red)

### compaction-model

Environment variables:
```bash
COMPACTION_MODEL_PROVIDER=litellm
COMPACTION_MODEL_ID=Qwen3.5-8B
COMPACTION_MODEL_BASE_URL=http://localhost:4000/v1
COMPACTION_MODEL_API_KEY=your-key
COMPACTION_MODEL_MAX_TOKENS=8192
```

### working-indicator

Commands:
- `/working-indicator` — show current mode
- `/working-indicator dot` — static dot
- `/working-indicator pulse` — animated pulse
- `/working-indicator spinner` — rainbow spinner
- `/working-indicator auto` — context-aware (default)
- `/working-indicator none` — hide indicator
- `/working-indicator reset` — restore Pi default

### response-latency

No configuration needed. Shows latency in status bar with phases:
- `< 2s` — ⚡ fast (green)
- `2-5s` — ◉ normal (yellow)
- `5-10s` — ◈ slow (orange)
- `> 10s` — ✖ stalling (red)

## Development

Extensions use Pi's Extension API. See [Pi Extensions Docs](https://github.com/earendil-works/pi-coding-agent/docs/extensions.md) for the full API reference.

## Agents

Global agent instructions for Pi Coding Agent. See [agents/AGENTS.md](./agents/AGENTS.md).

Install:
```bash
cp agents/AGENTS.md ~/.pi/agent/AGENTS.md
```

## Skills

Reusable procedures and patterns for Pi Coding Agent.

### Built-in Skills (Pi Core)

| Skill | Description |
|-------|-------------|
| [build](./skills/build/SKILL.md) | Implement one task or scoped change |
| [coverage](./skills/coverage/SKILL.md) | Evaluate test coverage and fill gaps |
| [plan](./skills/plan/SKILL.md) | Break work into agent-ready tasks |
| [review](./skills/review/SKILL.md) | Review code changes for bugs and risks |
| [spec](./skills/spec/SKILL.md) | Write implementation specs |
| [startup](./skills/startup/SKILL.md) | Read and understand a project |

### Superpowers Skills

| Skill | Description |
|-------|-------------|
| [brainstorming](./skills/brainstorming/SKILL.md) | Explore intent before creative work |
| [dispatching-parallel-agents](./skills/dispatching-parallel-agents/SKILL.md) | Parallel task execution |
| [executing-plans](./skills/executing-plans/SKILL.md) | Execute plans with review checkpoints |
| [finishing-a-development-branch](./skills/finishing-a-development-branch/SKILL.md) | Complete and integrate work |
| [receiving-code-review](./skills/receiving-code-review/SKILL.md) | Handle code review feedback |
| [requesting-code-review](./skills/requesting-code-review/SKILL.md) | Request code review |
| [subagent-driven-development](./skills/subagent-driven-development/SKILL.md) | Parallel subagent task execution |
| [systematic-debugging](./skills/systematic-debugging/SKILL.md) | Debug with evidence |
| [test-driven-development](./skills/test-driven-development/SKILL.md) | TDD workflow |
| [using-git-worktrees](./skills/using-git-worktrees/SKILL.md) | Git worktree isolation |
| [using-superpowers](./skills/using-superpowers/SKILL.md) | Find and use skills |
| [verification-before-completion](./skills/verification-before-completion/SKILL.md) | Verify before claiming done |
| [writing-plans](./skills/writing-plans/SKILL.md) | Write execution plans |
| [writing-skills](./skills/writing-skills/SKILL.md) | Create new skills |

Install:
```bash
# Install all skills
cp -r skills/* ~/.pi/agent/skills/

# Or individual
cp -r skills/build ~/.pi/agent/skills/
```

## License

MIT
