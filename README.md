# taskforce

A Claude Code plugin for long-running feature work: a ledger of tasks, Definition-of-Done gates that decide by exit code, guards that keep agents away from locked tests and the ledger, and a live dashboard. Work runs on the master session by default (cheapest); tasks fan out to builder/gate subagents only when several can run in parallel, or when you turn on orchestrator mode.

## Install

```
/plugin marketplace add trangtoan293/taskforce
/plugin install taskforce@taskforce
```

Or for one session from a local clone: `claude --plugin-dir /path/to/taskforce`.

## Use: four steps

Type `/tf` at any time. The dashboard's top box always says which step you are on and the exact command to type next.

| Step | Type | What happens | You do |
|---|---|---|---|
| 1. Set up (once per repo) | `/taskforce:setup` | Claude finds the repo's build/test commands and proposes gates and locked files | Approve the table |
| 2. Plan | `/taskforce:plan <what to build>` | Claude splits the work into small tasks, each with testable acceptance criteria | Approve or edit the plan |
| 3. Run | `/taskforce:run` | Tasks are built in their own git worktrees, pass the gates, then merge into the integration branch | Watch `/tf`; re-run if interrupted |
| 4. Review | `/tf` | See what merged and what is blocked, with the reason | `/tf retry <id>`; merge the integration branch to main yourself |

### Commands

| Command | Does |
|---|---|
| `/tf` | Open the dashboard (keys 1–5 switch tabs: overview, tasks, agents, flow, help) |
| `/tf master on\|off` | Orchestrator mode: the master may read, explore and plan but not write; work goes to subagents |
| `/tf pause` · `/tf resume` | Stop / restart every agent at its next tool call |
| `/tf retry <id\|all>` | Put a blocked task back in the queue with fresh attempts |
| `/tf stop <id>` | Block one task |
| `/tf status` | The task table as text |

Dashboard keys: **M** orchestrator mode · **X** pause · **C** resume · **T** retry blocked tasks.
A file named `AGENT_STOP` in the repo root halts every tool call (hard kill switch).

## How it decides who works

| Situation | Who builds |
|---|---|
| One runnable task (default) | The master itself (`TF-SOLO`), saving the start-up cost of subagents |
| Two or more tasks that can run in parallel | Builder + gate subagents via the `tf-run` workflow |
| Orchestrator mode on | Always subagents |

Whoever builds, the result goes through the same gate script and merge queue.

## What it guarantees

- **Gates decide, not the model.** `scripts/tf-gate.sh` runs every gate command and checks `git diff` against locked paths; `scripts/tf-merge.sh` merges one task at a time, re-runs the gates and rolls back on failure. Both decide by exit code and print JSON.
- **Locked files stay locked.** Writes to the ledger, `taskforce.json` and `locked` globs are refused by a `tool.call` hook; the gate's `git diff` is the authoritative check (the hook is only the fast path).
- **Retries are bounded.** Three attempts per task; the same error twice blocks early; a builder may report `impossible` instead of gaming a test.
- **State is on disk.** `.taskforce/tasks.json` (ledger) and `.taskforce/metrics.jsonl` (events, tokens per agent) survive restarts; `/taskforce:run` resumes from them.

## Repo files it uses

| File | Committed | Purpose |
|---|---|---|
| `taskforce.json` | yes | `base` branch, `gates` (name → command), `locked` globs, `maxParallel` |
| `.taskforce/` | no (gitignored) | ledger, metrics, pause and mode flags |
| `.tf-worktrees/` | no (gitignored) | one git worktree per task |

## Layout

```
.claude-plugin/plugin.json   manifest
hooks/register.ts            everything that touches the engine: guard, tf tool, /tf, dashboard wiring
hooks/ledger.ts              pure ledger logic and guard matching
hooks/telemetry.ts           agents, tokens, master→slave tree, progress
hooks/guide.ts               the "next step" for the person
hooks/pane.tsx               the dashboard
workflows/tf-run.js          builder + gate subagents per task
scripts/                     tf-gate.sh, tf-merge.sh (deterministic), test.sh
skills/                      setup, plan, run
```

## Develop

```
claude plugin validate .
claude plugin test .     # plugin tests
bash scripts/test.sh     # gate and merge script tests
```

Requires a Claude Code build with function-hook plugins (mods). Early-access API: it may change between releases.
