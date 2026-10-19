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
  isReadOnlyCommand,
  isTrustedScriptCall,
  masterMayRun,
  newTask,
  WRITE_TOOLS,
  parseConfig,
  parseLedger,
  report,
  requeueBuilding,
  retry,
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
const PAUSE_FILE = `${LEDGER_DIR}/paused`
const MODE_FILE = `${LEDGER_DIR}/mode`
const MASTER_DENY =
  'taskforce: đang ở CHẾ ĐỘ ĐIỀU PHỐI — phiên chính chỉ đọc, khám phá và lên kế hoạch, không tự sửa file. ' +
  'Hãy chia việc bằng /taskforce:plan rồi giao cho slave bằng /taskforce:run. (Tắt chế độ này: /tf master off)'
const MASTER_RULES = `# Taskforce orchestrator mode
This applies to the main session only. If you are a subagent that a workflow gave a task, ignore this section.
The person turned on orchestrator mode for this repository: you are the master. You read, explore, query, ask questions and plan; you never edit files or run commands that change the repo yourself (the taskforce guard refuses them).
When the person asks for work that changes the repo, turn it into tasks: follow the taskforce:plan skill (propose tasks, get approval, tf action "add"), then the taskforce:run skill, which hands each task to builder and gate subagents.
Answer questions and do read-only exploration directly; delegate only the work that writes.`
const POLL_MS = 3000


// ---------- state the dashboard reads ----------

const EMPTY: Board = { hasConfig: false, hasLedger: false, paused: false, masterMode: false, repo: '', tasks: [], events: [], killSwitch: false }
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

// ponytail: pause is a file holding yes/no because $.fs cannot delete; AGENT_STOP stays the hard stop.
const isPaused = async ($: $) => (await $.fs.exists(PAUSE_FILE)) && (await readText($, PAUSE_FILE)).trim() === 'yes'
const setPaused = ($: $, value: boolean) => $.fs.write(PAUSE_FILE, value ? 'yes\n' : 'no\n')
const isMaster = async ($: $) => (await $.fs.exists(MODE_FILE)) && (await readText($, MODE_FILE)).trim() === 'master'
const setMaster = ($: $, value: boolean) => $.fs.write(MODE_FILE, value ? 'master\n' : 'normal\n')

async function retryBlocked($: $, id?: string): Promise<string> {
  let l = await loadLedger($)
  const ids = id && id !== 'all' ? [id] : l.tasks.filter(t => t.status === 'blocked').map(t => t.id)
  if (!ids.length) return 'taskforce: không có task nào đang blocked.'
  for (const x of ids) l = retry(l, x)
  await saveLedger($, l)
  await logMetric($, { event: 'retry', tasks: ids })
  return `taskforce: ${ids.join(', ')} quay lại hàng chờ với 3 lượt thử mới. Gõ /taskforce:run để chạy.`
}

// ---------- dashboard ----------

async function showStatus($: $) {
  const board = await read($, boardAtom)
  if (!board.hasLedger) return $.ui.status(undefined)
  const agents = await read($, agentsAtom)
  const { pct, blocked } = overallProgress(board.tasks, agents)
  const t = totals(agents)
  const merged = board.tasks.filter(x => x.status === 'merged').length
  const stopNote = board.killSwitch ? ' · ⛔ AGENT_STOP' : ''
  $.ui.status(`${board.masterMode ? '◆ MASTER · ' : ''}tf ${pct}% · ${merged}/${board.tasks.length} xong · ${blocked} blocked · ${t.running} agent · ${fmtTok(t.tokensIn + t.tokensOut)} tok${stopNote}`)
}

// Re-reads ledger and metrics; writes the atom only on change, so the pane redraws only then.
async function refreshBoard($: $) {
  const killSwitch = await $.fs.exists(STOP_FILE)
  const hasConfig = await $.fs.exists(CONFIG_PATH)
  const paused = await isPaused($)
  const masterMode = await isMaster($)
  const repo = await repoRoot($)
  const next: Board = (await $.fs.exists(LEDGER_PATH))
    ? { hasConfig, hasLedger: true, paused, masterMode, repo, tasks: (await loadLedger($)).tasks, events: (await loadMetrics($)).slice(-300), killSwitch }
    : { ...EMPTY, hasConfig, paused, masterMode, repo, killSwitch }
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

// Economy: a lone task is built by the master itself (no subagents, ~100k tokens of start-up saved);
// it goes through the same worktree, the same gate script and the same merge as a delegated one.
function soloText(t: Task, cfg: Config, repo: string, root: string): string {
  const wt = `${repo}/${WORKTREE_DIR}/${t.id}`
  const branch = `tf/${t.id}`
  const gate = `bash ${sq(`${root}/scripts/tf-gate.sh`)} ${sq(wt)} ${sq(cfg.base)} ${cfg.locked.map(sq).join(' ')}${cfg.locked.length ? ' ' : ''}-- ${gateSpecs(cfg)}`
  return [
    `TF-SOLO: only ${t.id} is runnable, so do it yourself here (no subagents, no Workflow).`,
    `1. Worktree: if ${wt} is missing, run git -C ${sq(repo)} worktree add ${WORKTREE_DIR}/${t.id} ${branch} when branch ${branch} exists, else git -C ${sq(repo)} worktree add ${WORKTREE_DIR}/${t.id} -b ${branch} ${cfg.base}. Then git -C ${sq(wt)} rebase ${cfg.base} (resolve conflicts keeping both sides).`,
    `2. Task "${t.title}": ${t.goal}`,
    `   Acceptance (each covered by a test or check): ${t.accept.map((a, i) => `(${i + 1}) ${a}`).join(' ')}`,
    t.lastError ? `   The previous attempt failed with: ${t.lastError}` : '',
    t.notes ? `   Notes: ${t.notes}` : '',
    `   Edit only under ${wt}. Never touch locked paths (${cfg.locked.join(', ') || 'none'}), the ledger or the config. Commit everything on ${branch}.`,
    `   If it cannot be done without breaking a locked test, report outcome "impossible" with the reason instead of working around it.`,
    `3. Run exactly this one Bash command (do not edit or pipe it); it prints {"pass":...,"failures":[...]}:`,
    gate,
    `4. Call tf action "report" with results [{"id":"${t.id}","outcome":"pass" or "fail","branch":"${branch}","error":<failures joined, if any>,"notes":<one-line summary>}]. Then call tf action "next".`,
  ].filter(Boolean).join('\n')
}

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
        const solo = d.tasks.length === 1 && !(await isMaster($))
        await logMetric($, { event: 'claim', tasks: d.tasks.map(t => t.id), ...(solo ? { role: 'master' } : {}) })
        const repo = await repoRoot($)
        return solo ? soloText(d.tasks[0], cfg, repo, $.plugin.root) : buildText(d.tasks, cfg, repo, $.plugin.root)
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

    case 'requeue': {
      const l = requeueBuilding(await loadLedger($))
      await saveLedger($, l)
      return statusText(l)
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
- next: what to do now. Returns TF-SOLO (one task: do it yourself, run the gate command, report), TF-BUILD (several tasks: run a workflow, then report), TF-MERGE (run a merge command, then report) or TF-DONE.
- report: apply results; "results" is an array of {id, outcome: pass|fail|impossible|merged|merge-fail, branch?, error?, notes?}.
- add: add tasks; "tasks" is an array of {id, title, goal, accept: string[], files?: string[], deps?: string[]}.
- stop: block one task ("id").
- requeue: put tasks left "building" by a run that died back in the queue (call once before a new run).
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
    if (await isPaused($)) return { deny: 'taskforce: đang tạm dừng (/tf resume để tiếp tục).' }
    const command = String(e.command ?? '')
    // Master mode binds the main loop only (no agentId); slaves keep their normal tools.
    if (!e.agentId && (await isMaster($)) && !masterMayRun(e.tool, command, $.plugin.root))
      return { deny: MASTER_DENY }
    const locked = await loadConfig($).then(c => c.locked, () => [] as string[])
    const path = WRITE_TOOLS.has(e.tool) ? String(e.file_path ?? e.notebook_path ?? '') : ''
    if (path && isProtectedPath(path, locked))
      return { deny: `taskforce: ${path} is protected (ledger, ${CONFIG_PATH} or a locked test). Use the tf tool for the ledger; locked tests are read-only.` }
    if (e.tool === 'Bash' && !isTrustedScriptCall(command, $.plugin.root) && !isReadOnlyCommand(command) && bashTouchesProtected(command, locked))
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
      setPaused: (paused: boolean) => void setPaused($, paused).then(() => refreshBoard($)),
      setMaster: (master: boolean) => void setMaster($, master).then(() => refreshBoard($)),
      retryBlocked: () => void retryBlocked($).then(text => $.ui.toast(text)).then(() => refreshBoard($)),
    })
  })

  // In master mode the main session is told it orchestrates; the guard above enforces it.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!(await isMaster($).catch(() => false))) return r
    return { sections: [...r.sections, { id: 'taskforce:master', text: MASTER_RULES, scope: 'session' as const }] }
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
          action: { type: 'string', enum: ['status', 'next', 'report', 'add', 'stop', 'init', 'requeue'] },
          results: { type: 'array', items: { type: 'object' } },
          tasks: { type: 'array', items: { type: 'object' } },
          id: { type: 'string' },
          config: { type: 'object' },
        },
        required: ['action'],
      },
    })
    await $.command.register({ name: 'tf', description: 'taskforce: mở dashboard (help · status · master on|off · pause · resume · retry <id> · stop <id>)', argumentHint: 'help | status | master on|off | pause | resume | retry <id> | stop <id>' })
    await refreshBoard($).catch(() => undefined)
    // ponytail: fixed 3s poll of two small files; switch to a file watch if one becomes available.
    $.clock.every(POLL_MS, () => void refreshBoard($).catch(() => undefined))
    return r
  })

  on('command.run', { command: 'tf' }, async ($, e) => {
    const [sub = 'ui', id] = e.args.trim().split(/\s+/).filter(Boolean)
    try {
      switch (sub) {
        case 'ui':
        case 'help': {
          if (sub === 'help') await update($, tabAtom, () => 'help' as Tab)
          await refreshBoard($)
          const { isPlaced } = await $.ui.open({ id: PANE, title: 'Taskforce' })
          return { text: isPlaced ? 'taskforce: dashboard đã mở. Làm theo khung "Bước tiếp theo" ở trên cùng.' : 'taskforce: dashboard sẽ mở khi terminal đủ chỗ.' }
        }
        case 'status':
          return { text: statusText(await loadLedger($)) }
        case 'pause':
          await setPaused($, true)
          await refreshBoard($)
          return { text: 'taskforce: ĐÃ TẠM DỪNG. Mọi agent bị chặn ở lần gọi tool kế tiếp. /tf resume để tiếp tục.' }
        case 'master': {
          if (!(await $.fs.exists(CONFIG_PATH))) return { text: 'taskforce: repo này chưa cài. Chạy /taskforce:setup trước.' }
          const turnOn = id === 'on' ? true : id === 'off' ? false : !(await isMaster($))
          await setMaster($, turnOn)
          await refreshBoard($)
          return {
            text: turnOn
              ? 'taskforce: ĐÃ BẬT chế độ điều phối. Phiên chính chỉ đọc và lên kế hoạch; mọi việc sửa repo phải đi qua /taskforce:plan → /taskforce:run (slave làm). Tắt: /tf master off'
              : 'taskforce: đã tắt chế độ điều phối. Phiên chính làm việc bình thường.',
          }
        }
        case 'resume':
          await setPaused($, false)
          await refreshBoard($)
          return { text: 'taskforce: đã tiếp tục. Nếu vòng lặp đã dừng hẳn, gõ /taskforce:run.' }
        case 'retry':
          return { text: await retryBlocked($, id) }
        case 'stop':
          if (!id) return { text: 'usage: /tf stop <id>  (dừng hẳn 1 task). Dừng tất cả: /tf pause' }
          return { text: await runAction($, { action: 'stop', id }) }
        case 'run':
          return { text: 'taskforce: gõ /taskforce:run để chạy (Claude làm hết các task đang chờ).' }
        default:
          return { text: 'Các lệnh: /tf (dashboard) · /tf help · /tf status · /tf master on|off · /tf pause · /tf resume · /tf retry <id|all> · /tf stop <id>\nCác bước: /taskforce:setup → /taskforce:plan <mô tả> → /taskforce:run' }
      }
    } catch (err) {
      return { text: `taskforce: ${String(err instanceof Error ? err.message : err)}` }
    }
  })
}
