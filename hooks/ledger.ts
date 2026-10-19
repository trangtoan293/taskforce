// Pure ledger logic: no `$`, no I/O. register.ts does the reading and writing.

export type Status = 'pending' | 'building' | 'ready' | 'merged' | 'blocked'
const STATUSES: readonly Status[] = ['pending', 'building', 'ready', 'merged', 'blocked']

export type Task = {
  id: string
  title: string
  goal: string
  accept: string[]
  files?: string[]
  deps?: string[]
  status: Status
  attempts: number
  maxAttempts?: number
  lastError?: string
  notes?: string
  branch?: string
}
export type Ledger = { tasks: Task[] }

export type Config = {
  base: string
  gates: Record<string, string>
  locked: string[]
  maxParallel: number
}

export type Outcome = {
  id: string
  outcome: 'pass' | 'fail' | 'impossible' | 'merged' | 'merge-fail'
  branch?: string
  error?: string
  notes?: string
}

export type Next =
  | { kind: 'merge'; tasks: Task[] }
  | { kind: 'build'; tasks: Task[]; ledger: Ledger }
  | { kind: 'done'; blocked: string[]; stuck: string[] }

export const DEFAULT_MAX_ATTEMPTS = 3
export const LEDGER_DIR = '.taskforce'
export const LEDGER_PATH = `${LEDGER_DIR}/tasks.json`
export const CONFIG_PATH = 'taskforce.json'
export const WORKTREE_DIR = '.tf-worktrees'

// ---------- parsing (system boundary: validate, fail loud) ----------

export function parseLedger(text: string): Ledger {
  const raw = JSON.parse(text) as { tasks?: unknown }
  if (!Array.isArray(raw.tasks)) throw new Error('ledger: "tasks" must be an array')
  const seen = new Set<string>()
  const tasks = raw.tasks.map((t: Task, i: number) => {
    if (typeof t?.id !== 'string' || !t.id) throw new Error(`ledger: task #${i} has no id`)
    if (seen.has(t.id)) throw new Error(`ledger: duplicate task id "${t.id}"`)
    seen.add(t.id)
    if (!STATUSES.includes(t.status)) throw new Error(`ledger: task "${t.id}" has unknown status "${t.status}"`)
    if (!Array.isArray(t.accept) || t.accept.length === 0)
      throw new Error(`ledger: task "${t.id}" needs at least one acceptance criterion`)
    return { ...t, attempts: Number(t.attempts) || 0 }
  })
  return { tasks }
}

export function parseConfig(text: string): Config {
  const raw = JSON.parse(text) as Partial<Config>
  const gates = raw.gates ?? {}
  if (Object.keys(gates).length === 0) throw new Error('taskforce.json: define at least one gate command')
  return {
    base: raw.base ?? 'develop',
    gates,
    locked: raw.locked ?? [],
    maxParallel: raw.maxParallel ?? 3,
  }
}

export function newTask(input: Partial<Task> & Pick<Task, 'id' | 'title' | 'goal' | 'accept'>): Task {
  return { ...input, status: 'pending', attempts: 0 }
}

// ---------- transitions (all return new objects) ----------

const replace = (l: Ledger, t: Task): Ledger => ({ tasks: l.tasks.map(x => (x.id === t.id ? t : x)) })

const find = (l: Ledger, id: string): Task => {
  const t = l.tasks.find(x => x.id === id)
  if (!t) throw new Error(`no task "${id}"`)
  return t
}

const expect = (t: Task, ...allowed: Status[]) => {
  if (!allowed.includes(t.status))
    throw new Error(`task "${t.id}" is ${t.status}; expected ${allowed.join(' or ')}`)
}

// Two errors that differ only in numbers and spacing count as the same failure.
export const signature = (err = '') =>
  err.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160)

const runnable = (l: Ledger, t: Task) =>
  t.status === 'pending' && (t.deps ?? []).every(d => l.tasks.find(x => x.id === d)?.status === 'merged')

export function claim(l: Ledger, max: number): { ledger: Ledger; claimed: Task[] } {
  const claimed: Task[] = []
  const busy = new Set<string>()
  for (const t of l.tasks) {
    if (claimed.length >= max) break
    if (!runnable(l, t)) continue
    const files = t.files ?? []
    if (files.some(f => busy.has(f))) continue
    files.forEach(f => busy.add(f))
    claimed.push({ ...t, status: 'building', attempts: t.attempts + 1 })
  }
  const ledger = claimed.reduce(replace, l)
  return { ledger, claimed }
}

function failed(t: Task, error: string): Task {
  const max = t.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const repeated = !!t.lastError && signature(t.lastError) === signature(error)
  const status: Status = t.attempts >= max || repeated ? 'blocked' : 'pending'
  return { ...t, status, lastError: error }
}

export function report(l: Ledger, o: Outcome): Ledger {
  const t = find(l, o.id)
  const notes = o.notes ?? t.notes
  switch (o.outcome) {
    case 'pass':
      expect(t, 'building')
      return replace(l, { ...t, status: 'ready', branch: o.branch ?? t.branch, notes })
    case 'fail':
      expect(t, 'building')
      return replace(l, { ...failed(t, o.error ?? 'unknown failure'), branch: o.branch ?? t.branch, notes })
    case 'impossible':
      expect(t, 'building')
      return replace(l, { ...t, status: 'blocked', lastError: `impossible: ${o.error ?? ''}`.trim(), notes })
    case 'merged':
      expect(t, 'ready')
      return replace(l, { ...t, status: 'merged', notes })
    case 'merge-fail':
      expect(t, 'ready')
      return replace(l, { ...failed(t, o.error ?? 'merge failed'), notes })
  }
}

export function requeueBuilding(l: Ledger): Ledger {
  return {
    tasks: l.tasks.map(t =>
      t.status === 'building' ? { ...t, status: 'pending', attempts: Math.max(0, t.attempts - 1) } : t,
    ),
  }
}

export function stop(l: Ledger, id: string): Ledger {
  const t = find(l, id)
  if (t.status === 'merged') throw new Error(`task "${id}" is already merged`)
  return replace(l, { ...t, status: 'blocked', lastError: 'stopped by operator' })
}

export function decideNext(l: Ledger, cfg: Config): Next {
  const ready = l.tasks.filter(t => t.status === 'ready')
  if (ready.length) return { kind: 'merge', tasks: ready }
  const { ledger, claimed } = claim(l, cfg.maxParallel)
  if (claimed.length) return { kind: 'build', tasks: claimed, ledger }
  return {
    kind: 'done',
    blocked: l.tasks.filter(t => t.status === 'blocked').map(t => t.id),
    stuck: l.tasks.filter(t => t.status === 'pending').map(t => t.id),
  }
}

// ---------- guard matching ----------

const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

// Anchored on a path separator, so a locked glob also matches inside any worktree.
export const globToRegex = (glob: string) =>
  new RegExp(
    '(^|/)' + escape(glob).replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$',
  )

export function isProtectedPath(path: string, locked: string[]): boolean {
  if (/(^|\/)\.taskforce\//.test(path) || /(^|\/)taskforce\.json$/.test(path)) return true
  return locked.some(g => globToRegex(g).test(path))
}

// Exactly `bash '<root>/scripts/tf-gate.sh|tf-merge.sh' '<arg>' ...` with every argument single-quoted
// (embedded quotes as '\''): nothing outside the quotes can chain, redirect or substitute.
export function isTrustedScriptCall(command: string, root: string): boolean {
  const arg = `'(?:[^']|'\\\\'')*'`
  const script = `'${escape(root)}/scripts/tf-(?:gate|merge)\\.sh'`
  return new RegExp(`^bash ${script}(?: (?:${arg}|--))*$`).test(command.trim())
}

// ponytail: substring match on the command text; `${f}`-style spellings slip past.
// The gate's git diff over locked paths is the authoritative check.
export function bashTouchesProtected(command: string, locked: string[]): boolean {
  const literal = (g: string) => g.split('*')[0]
  return [`${LEDGER_DIR}/`, CONFIG_PATH, ...locked.map(literal).filter(Boolean)].some(p => command.includes(p))
}
