// Everything that touches `$` lives here: the engine follows `$` only into functions of this file.
// Pure logic sits in ledger.ts / telemetry.ts / format.ts; drawing in pane.tsx.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { AgentRec, Board, MetricRow, Tab } from '../types'
import { fmtTok } from './format'
import {
  CONFIG_PATH,
  LEDGER_DIR,
  LEDGER_PATH,
  WORKTREE_DIR,
  bashTouchesProtected,
  decideNext,
  isProtectedPath,
  isTrustedScriptCall,
  newTask,
  parseConfig,
  parseLedger,
  report,
  requeueBuilding,
  stop,
  type Config,
  type Ledger,
  type Outcome,
  type Task,
} from './ledger'
import { renderPane } from './pane'
import { onSpawn, onToolCall, onTurn, overallProgress, totals } from './telemetry'

type $ = EngineInterface

const TOOL = 'tf'
const TOOL_FULL = 'mcp__taskforce__tf'
const WORKFLOW = 'taskforce:tf-run'
const STOP_FILE = 'AGENT_STOP'
const METRICS = `${LEDGER_DIR}/metrics.jsonl`
const PANE = 'taskforce'
const POLL_MS = 3000
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const GOAL = [
  'Taskforce loop for this repository. Repeatedly call the tf tool (mcp__taskforce__tf) with action "next"',
  'and do exactly what it returns: TF-BUILD means run the named workflow with the given args and then call tf',
  'action "report" with the workflow\'s returned array as "results"; TF-MERGE means run the given command and',
  'report its output. Never edit the ledger or the config file yourself.',
  'The goal is met when a tf "next" call in this conversation returns a line starting with TF-DONE.',
].join(' ')

// ---------- state the dashboard reads ----------

const EMPTY: Board = { hasLedger: false, repo: '', tasks: [], events: [], killSwitch: false }
const agentsAtom = atom({ plugin: 'taskforce', key: 'agents' } as const, [] as AgentRec[])
const boardAtom = atom({ plugin: 'taskforce', key: 'board' } as const, EMPTY)
const tabAtom = atom({ plugin: 'taskforce', key: 'tab' } as const, 'overview' as Tab)

// ---------- I/O ----------

const readText = async ($: $, path: string) => String(await $.fs.read(path))

async function loadConfig($: $): Promise<Config> {
  if (!(await $.fs.exists(CONFIG_PATH))) throw new Error(`no ${CONFIG_PATH} here; run tf action "init" first`)
  return parseConfig(await readText($, CONFIG_PATH))
}

async function loadLedger($: $): Promise<Ledger> {
  return (await $.fs.exists(LEDGER_PATH)) ? parseLedger(await readText($, LEDGER_PATH)) : { tasks: [] }
}

const saveLedger = ($: $, l: Ledger) => $.fs.write(LEDGER_PATH, JSON.stringify(l, null, 2) + '\n')

// ponytail: read+rewrite append; fine for a few thousand rows, rotate if it grows.
async function logMetric($: $, row: Omit<MetricRow, 'ts'>) {
  const prev = (await $.fs.exists(METRICS)) ? await readText($, METRICS) : ''
  await $.fs.write(METRICS, prev + JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n')
}

async function loadMetrics($: $): Promise<MetricRow[]> {
  if (!(await $.fs.exists(METRICS))) return []
  return (await readText($, METRICS)).split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line) as MetricRow]
    } catch {
      return []
    }
  })
}

const repoRoot = async ($: $) => (await $.fs.stat('.', { resolve: true })).realPath ?? '.'

// ---------- dashboard ----------

async function showStatus($: $) {
  const board = await read($, boardAtom)
  if (!board.hasLedger) return $.ui.status(undefined)
  const agents = await read($, agentsAtom)
  const { pct, blocked } = overallProgress(board.tasks, agents)
  const t = totals(agents)
  const merged = board.tasks.filter(x => x.status === 'merged').length
  const stopNote = board.killSwitch ? ' · ⛔ AGENT_STOP' : ''
  $.ui.status(`tf ${pct}% · ${merged}/${board.tasks.length} xong · ${blocked} blocked · ${t.running} agent · ${fmtTok(t.tokensIn + t.tokensOut)} tok${stopNote}`)
}

// Re-reads ledger and metrics; writes the atom only on change, so the pane redraws only then.
async function refreshBoard($: $) {
  const killSwitch = await $.fs.exists(STOP_FILE)
  const next: Board = (await $.fs.exists(LEDGER_PATH))
    ? { hasLedger: true, repo: await repoRoot($), tasks: (await loadLedger($)).tasks, events: (await loadMetrics($)).slice(-300), killSwitch }
    : { ...EMPTY, killSwitch }
  if (JSON.stringify(await read($, boardAtom)) !== JSON.stringify(next)) await update($, boardAtom, () => next)
  await showStatus($)
}

// ---------- text the model reads ----------

function statusText(l: Ledger): string {
  if (!l.tasks.length) return 'taskforce: no tasks yet (tf action "add").'
  const rows = l.tasks.map(t => {
    const err = t.lastError ? `  ⚠ ${t.lastError.split('\n')[0].slice(0, 80)}` : ''
    return `${t.id.padEnd(8)} ${t.status.padEnd(8)} try ${t.attempts}  ${t.title}${err}`
  })
  const count = (s: Task['status']) => l.tasks.filter(t => t.status === s).length
  const summary = (['pending', 'building', 'ready', 'merged', 'blocked'] as const).map(s => `${s} ${count(s)}`)
  return [...rows, '', summary.join(' · ')].join('\n')
}

const forWorkflow = (t: Task) => ({
  id: t.id,
  title: t.title,
  goal: t.goal,
  accept: t.accept,
  files: t.files ?? [],
  attempt: t.attempts,
  lastError: t.lastError ?? '',
  notes: t.notes ?? '',
})

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const gateSpecs = (cfg: Config) => Object.entries(cfg.gates).map(([n, c]) => sq(`${n}=${c}`)).join(' ')

function buildText(tasks: Task[], cfg: Config, repo: string, root: string): string {
  const args = { repo, base: cfg.base, gates: cfg.gates, locked: cfg.locked, gateScript: `${root}/scripts/tf-gate.sh`, tasks: tasks.map(forWorkflow) }
  return [
    `TF-BUILD: ${tasks.map(t => t.id).join(', ')} are now building.`,
    `Call the Workflow tool with name "${WORKFLOW}" and exactly these args:`,
    JSON.stringify(args),
    'When it completes, call tf with action "report" and "results" set to the array it returned, unchanged.',
  ].join('\n')
}

// The script merges, re-runs the gates and rolls back by exit code; the model only relays its JSON.
function mergeText(tasks: Task[], cfg: Config, repo: string, root: string): string {
  const pairs = tasks.map(t => sq(`${t.id}:${t.branch ?? `tf/${t.id}`}`)).join(' ')
  const cmd = `bash ${sq(`${root}/scripts/tf-merge.sh`)} ${sq(repo)} ${sq(cfg.base)} ${pairs} -- ${gateSpecs(cfg)}`
  return [
    `TF-MERGE: ${tasks.map(t => t.id).join(', ')} are ready. Run exactly this one Bash command (do not edit or pipe it):`,
    cmd,
    'It prints a JSON array. Call tf with action "report" and "results" set to that array, unchanged. Then call tf action "next".',
  ].join('\n')
}

function doneText(l: Ledger, blocked: string[], stuck: string[]): string {
  const why = (id: string) => `${id}: ${l.tasks.find(t => t.id === id)?.lastError?.split('\n')[0] ?? ''}`
  return [
    'TF-DONE: nothing left to build or merge.',
    `merged: ${l.tasks.filter(t => t.status === 'merged').map(t => t.id).join(', ') || 'none'}`,
    `blocked (needs the user): ${blocked.map(why).join(' | ') || 'none'}`,
    `waiting on a blocked dependency: ${stuck.join(', ') || 'none'}`,
  ].join('\n')
}

// ---------- tf tool actions ----------

type TfInput = { action: string; results?: Outcome[]; tasks?: Partial<Task>[]; id?: string; config?: object }

async function runAction($: $, input: TfInput): Promise<string> {
  switch (input.action) {
    case 'status':
      return statusText(await loadLedger($))

    case 'init': {
      if (await $.fs.exists(CONFIG_PATH)) return `${CONFIG_PATH} already exists; only a human edits it.`
      const text = JSON.stringify(input.config ?? {}, null, 2) + '\n'
      parseConfig(text)
      await $.fs.write(CONFIG_PATH, text)
      const ignore = (await $.fs.exists('.gitignore')) ? await readText($, '.gitignore') : ''
      const missing = [`${LEDGER_DIR}/`, `${WORKTREE_DIR}/`, STOP_FILE].filter(p => !ignore.split('\n').includes(p))
      const sep = ignore && !ignore.endsWith('\n') ? '\n' : ''
      if (missing.length) await $.fs.write('.gitignore', ignore + sep + missing.join('\n') + '\n')
      return `wrote ${CONFIG_PATH}; .gitignore now ignores ${LEDGER_DIR}/ and ${WORKTREE_DIR}/. Commit both.`
    }

    case 'add': {
      const l = await loadLedger($)
      const added = (input.tasks ?? []).map(t => {
        if (!t.id || !t.title || !t.goal || !t.accept?.length)
          throw new Error('each task needs id, title, goal and at least one accept criterion')
        if (l.tasks.some(x => x.id === t.id)) throw new Error(`task "${t.id}" already exists`)
        return newTask({ ...t, id: t.id, title: t.title, goal: t.goal, accept: t.accept })
      })
      const next = parseLedger(JSON.stringify({ tasks: [...l.tasks, ...added] }))
      await saveLedger($, next)
      return `added ${added.length} task(s).\n\n${statusText(next)}`
    }

    case 'next': {
      const cfg = await loadConfig($)
      const l = await loadLedger($)
      const d = decideNext(l, cfg)
      if (d.kind === 'merge') return mergeText(d.tasks, cfg, await repoRoot($), $.plugin.root)
      if (d.kind === 'build') {
        await saveLedger($, d.ledger)
        await logMetric($, { event: 'claim', tasks: d.tasks.map(t => t.id) })
        return buildText(d.tasks, cfg, await repoRoot($), $.plugin.root)
      }
      return doneText(l, d.blocked, d.stuck)
    }

    case 'report': {
      let l = await loadLedger($)
      const problems: string[] = []
      for (const o of input.results ?? []) {
        try {
          l = report(l, o)
          const t = l.tasks.find(x => x.id === o.id)
          await logMetric($, { event: o.outcome, id: o.id, status: t?.status, attempt: t?.attempts, error: o.error?.slice(0, 300) })
        } catch (err) {
          problems.push(String(err))
        }
      }
      await saveLedger($, l)
      const warn = problems.length ? `\nnot applied: ${problems.join('; ')}` : ''
      return `${statusText(l)}${warn}\n\nNow call tf action "next".`
    }

    case 'stop': {
      const l = stop(await loadLedger($), String(input.id))
      await saveLedger($, l)
      return statusText(l)
    }

    default:
      throw new Error(`unknown action "${input.action}"`)
  }
}

const TOOL_DESCRIPTION = `Taskforce ledger and loop driver for this repository. The only way to read or change .taskforce/tasks.json.
Actions:
- status: the task table.
- next: what to do now. Returns TF-BUILD (run a workflow, then report), TF-MERGE (run a merge command, then report) or TF-DONE.
- report: apply results; "results" is an array of {id, outcome: pass|fail|impossible|merged|merge-fail, branch?, error?, notes?}.
- add: add tasks; "tasks" is an array of {id, title, goal, accept: string[], files?: string[], deps?: string[]}.
- stop: block one task ("id").
- init: write taskforce.json once from "config" {base?, gates: {name: command}, locked?: glob[], maxParallel?}.`

// ---------- wiring ----------

export const register: Register = on => {
  // Guard: kill switch, ledger/config, locked paths. Fast path only; gates re-check with git diff.
  // Also the one place tool calls are counted per agent for the dashboard.
  on('tool.call', async ($, e, next) => {
    await update($, agentsAtom, list => onToolCall(list, e.agentId, e.tool, Date.now()))
    if (await $.fs.exists(STOP_FILE))
      return { deny: `taskforce: kill switch engaged (${STOP_FILE} exists). A human removes it to resume.` }
    if (e.tool === TOOL_FULL) return next(e)
    const locked = await loadConfig($).then(c => c.locked, () => [] as string[])
    const path = WRITE_TOOLS.has(e.tool) ? String(e.file_path ?? e.notebook_path ?? '') : ''
    if (path && isProtectedPath(path, locked))
      return { deny: `taskforce: ${path} is protected (ledger, ${CONFIG_PATH} or a locked test). Use the tf tool for the ledger; locked tests are read-only.` }
    const command = String(e.command ?? '')
    if (e.tool === 'Bash' && !isTrustedScriptCall(command, $.plugin.root) && bashTouchesProtected(command, locked))
      return { deny: 'taskforce: this command names a protected path (ledger, config or locked test). Read files with the Read tool; change the ledger with the tf tool.' }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'taskforce: guard failed; refusing to be safe.' }))

  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    try {
      return { result: await runAction($, e as unknown as TfInput) }
    } catch (err) {
      return { deny: `tf: ${String(err instanceof Error ? err.message : err)}` }
    } finally {
      await refreshBoard($).catch(() => undefined)
    }
  })

  // Master → slave: who started each agent, under which workflow run, for which task.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = r.agentId
    if (id) {
      const spawn = { id, parent: e.parentAgentId ?? 'main', runId: e.workflow?.runId || undefined, label: e.description, prompt: e.prompt, model: r.model, at: Date.now() }
      await update($, agentsAtom, list => onSpawn(list, spawn))
    }
    return r
  })

  // Tokens per agent; a finished builder/gate is also written to metrics so totals survive sessions.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await update($, agentsAtom, list => onTurn(list, e.agentId, e.usage, Date.now()))
    const rec = e.agentId ? (await read($, agentsAtom)).find(a => a.id === e.agentId) : undefined
    if (rec && rec.role !== 'agent' && (await $.fs.exists(LEDGER_PATH))) {
      await logMetric($, {
        event: 'agent', id: rec.taskId, role: rec.role, agent: rec.label,
        tokensIn: rec.tokensIn, tokensOut: rec.tokensOut, cacheRead: rec.cacheRead,
        ms: (rec.endedAt ?? Date.now()) - rec.startedAt,
      })
    }
    await showStatus($)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [agents, board, tab] = await Promise.all([read($, agentsAtom), read($, boardAtom), read($, tabAtom)])
    return renderPane($.ui.resolve(e), {
      agents,
      board,
      tab,
      rows: e.viewport?.rows ?? 30,
      setTab: (t: Tab) => void update($, tabAtom, () => t),
    })
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.tool.register({
      name: TOOL,
      description: TOOL_DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'next', 'report', 'add', 'stop', 'init'] },
          results: { type: 'array', items: { type: 'object' } },
          tasks: { type: 'array', items: { type: 'object' } },
          id: { type: 'string' },
          config: { type: 'object' },
        },
        required: ['action'],
      },
    })
    await $.command.register({ name: 'tf', description: 'taskforce: ui | status | run | stop <id>', argumentHint: 'ui | status | run | stop <id>' })
    await refreshBoard($).catch(() => undefined)
    // ponytail: fixed 3s poll of two small files; switch to a file watch if one becomes available.
    $.clock.every(POLL_MS, () => void refreshBoard($).catch(() => undefined))
    return r
  })

  on('command.run', { command: 'tf' }, async ($, e) => {
    const [sub = 'status', id] = e.args.trim().split(/\s+/)
    try {
      if (sub === 'status') return { text: statusText(await loadLedger($)) }
      if (sub === 'stop') return { text: await runAction($, { action: 'stop', id }) }
      if (sub === 'run') {
        await loadConfig($)
        await saveLedger($, requeueBuilding(await loadLedger($)))
        // A command.run hook may not run another command (it would wait on the turn it holds), and a
        // queued $.prompt.submit did not start the goal in a live session; so start /goal from a timer
        // that fires after this hook has returned.
        $.clock.after(300, () =>
          void $.command.run({ command: 'goal', args: GOAL }).catch(err => $.ui.toast(`taskforce: could not start /goal: ${String(err)}`)),
        )
        return { text: 'taskforce: loop starting under /goal. /tf ui shows the dashboard; touch AGENT_STOP to halt everything.' }
      }
      if (sub === 'ui') {
        await refreshBoard($)
        const { isPlaced } = await $.ui.open({ id: PANE, title: 'Taskforce' })
        return { text: isPlaced ? 'taskforce: dashboard opened (keys 1–4 switch tabs).' : 'taskforce: dashboard queued; it opens when the terminal has room.' }
      }
      return { text: 'usage: /tf ui | /tf status | /tf run | /tf stop <id>' }
    } catch (err) {
      return { text: `taskforce: ${String(err instanceof Error ? err.message : err)}` }
    }
  })
}
