import type { EngineInterface, Register } from 'claude-code'
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

type $ = EngineInterface

const TOOL = 'tf'
const TOOL_FULL = 'mcp__taskforce__tf'
const WORKFLOW = 'taskforce:tf-run'
const STOP_FILE = 'AGENT_STOP'
const METRICS = `${LEDGER_DIR}/metrics.jsonl`
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const GOAL = [
  'Taskforce loop for this repository. Repeatedly call the tf tool (mcp__taskforce__tf) with action "next"',
  'and do exactly what it returns: TF-BUILD means run the named workflow with the given args and then call tf',
  'action "report" with the workflow\'s returned array as "results"; TF-MERGE means merge as instructed and report',
  'each task. Never edit .taskforce/ or taskforce.json yourself.',
  'The goal is met when a tf "next" call in this conversation returns a line starting with TF-DONE.',
].join(' ')

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

// ponytail: read+rewrite append; fine for a few hundred rows, switch to rotation if it grows.
async function logMetric($: $, row: Record<string, unknown>) {
  const prev = (await $.fs.exists(METRICS)) ? await readText($, METRICS) : ''
  await $.fs.write(METRICS, prev + JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n')
}

const repoRoot = async ($: $) => (await $.fs.stat('.', { resolve: true })).realPath ?? '.'

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
  const args = {
    repo,
    base: cfg.base,
    gates: cfg.gates,
    locked: cfg.locked,
    gateScript: `${root}/scripts/tf-gate.sh`,
    tasks: tasks.map(forWorkflow),
  }
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
- next: what to do now. Returns TF-BUILD (run a workflow, then report), TF-MERGE (merge ready branches, then report) or TF-DONE.
- report: apply results; "results" is an array of {id, outcome: pass|fail|impossible|merged|merge-fail, branch?, error?, notes?}.
- add: add tasks; "tasks" is an array of {id, title, goal, accept: string[], files?: string[], deps?: string[]}.
- stop: block one task ("id").
- init: write taskforce.json once from "config" {base?, gates: {name: command}, locked?: glob[], maxParallel?}.`

// ---------- wiring ----------

export const register: Register = on => {
  // Guard: kill switch, ledger/config, locked paths. Fast path only; gates re-check with git diff.
  on('tool.call', async ($, e, next) => {
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
    }
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
    await $.command.register({ name: 'tf', description: 'taskforce: status | run | stop <id>', argumentHint: 'status | run | stop <id>' })
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
        // Not awaited: a command.run hook may not wait on the turn it holds (P0 finding).
        $.prompt.submit({ text: `/goal ${GOAL}`, asUser: true }).catch(err => $.ui.toast(`taskforce: could not start /goal: ${String(err)}`))
        return { text: 'taskforce: loop starting under /goal. /goal shows progress; touch AGENT_STOP to halt everything.' }
      }
      return { text: 'usage: /tf status | /tf run | /tf stop <id>' }
    } catch (err) {
      return { text: `taskforce: ${String(err instanceof Error ? err.message : err)}` }
    }
  })
}
