// Pure agent telemetry: who spawned whom, tool activity, tokens, step-based progress.
import type { AgentRec, Role, Task } from '../types'
export type { AgentRec, Role }



export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }

export type Spawn = { id: string; parent: string; runId?: string; label: string; prompt: string; model?: string; at: number }

const MAIN = 'main'
const KEEP = 300 // ponytail: cap the in-memory list; history lives in metrics.jsonl

export function roleOf(label: string, prompt: string): { role: Role; taskId?: string } {
  const labelled = /^(build|gate):([\w.-]+)$/.exec(label.trim())
  if (labelled) return { role: labelled[1] === 'build' ? 'builder' : 'gate', taskId: labelled[2] }
  if (/gate runner/i.test(prompt)) {
    const id = /\.tf-worktrees\/([\w.-]+)/.exec(prompt)?.[1]
    return id ? { role: 'gate', taskId: id } : { role: 'gate' }
  }
  const built = /The task \(([\w.-]+), attempt/.exec(prompt)
  if (built) return { role: 'builder', taskId: built[1] }
  return { role: 'agent' }
}

const blank = (id: string, parent: string, label: string, role: Role, at: number): AgentRec => ({
  id, parent, label, role, status: 'running', tools: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, startedAt: at,
})

export function onSpawn(agents: AgentRec[], s: Spawn): AgentRec[] {
  const rec: AgentRec = { ...blank(s.id, s.parent, s.label, 'agent', s.at), ...roleOf(s.label, s.prompt), runId: s.runId, model: s.model }
  return [...agents.filter(a => a.id !== s.id), rec].slice(-KEEP)
}

const withAgent = (agents: AgentRec[], id: string, at: number, fn: (a: AgentRec) => AgentRec): AgentRec[] => {
  const found = agents.some(a => a.id === id)
  const base = found ? agents : [...agents, blank(id, MAIN, id === MAIN ? 'phiên chính' : id.slice(0, 8), id === MAIN ? 'main' : 'agent', at)]
  return base.map(a => (a.id === id ? fn(a) : a))
}

export function onToolCall(agents: AgentRec[], agentId: string | undefined, tool: string, at = 0): AgentRec[] {
  return withAgent(agents, agentId ?? MAIN, at, a => ({ ...a, tools: a.tools + 1, lastTool: tool }))
}

export function onTurn(agents: AgentRec[], agentId: string | undefined, usage: Usage | undefined, at: number): AgentRec[] {
  const id = agentId ?? MAIN
  return withAgent(agents, id, at, a => ({
    ...a,
    tokensIn: a.tokensIn + (usage?.input_tokens ?? 0),
    tokensOut: a.tokensOut + (usage?.output_tokens ?? 0),
    cacheRead: a.cacheRead + (usage?.cache_read_input_tokens ?? 0),
    ...(id === MAIN ? {} : { status: 'done' as const, endedAt: at }),
  }))
}

export function totals(agents: AgentRec[]) {
  return agents.reduce(
    (t, a) => ({
      tokensIn: t.tokensIn + a.tokensIn,
      tokensOut: t.tokensOut + a.tokensOut,
      cacheRead: t.cacheRead + a.cacheRead,
      running: t.running + (a.status === 'running' && a.id !== MAIN ? 1 : 0),
      agents: t.agents + 1,
    }),
    { tokensIn: 0, tokensOut: 0, cacheRead: 0, running: 0, agents: 0 },
  )
}

export type Node = { id: string; label: string; agent?: AgentRec; children: Node[] }

export function agentTree(agents: AgentRec[]): Node {
  const main = agents.find(a => a.id === MAIN)
  const subs = agents.filter(a => a.id !== MAIN)
  const leaf = (a: AgentRec): Node => ({ id: a.id, label: a.label, agent: a, children: [] })
  // One node per workflow run, placed where its first agent appeared; plain subagents stay leaves.
  const children = subs.flatMap((a, i): Node[] => {
    if (!a.runId) return [leaf(a)]
    if (subs.findIndex(s => s.runId === a.runId) !== i) return []
    return [{ id: a.runId, label: `workflow ${a.runId}`, children: subs.filter(s => s.runId === a.runId).map(leaf) }]
  })
  return { id: MAIN, label: 'phiên chính (master)', agent: main, children }
}

// Step-based, not effort-based: we know which stage a task is in, not how much code is left.
export function taskProgress(t: Task, agents: AgentRec[]): { pct: number; step: string } {
  const live = (role: Role) => agents.some(a => a.taskId === t.id && a.role === role && a.status === 'running')
  switch (t.status) {
    case 'pending': return { pct: 0, step: 'chờ' }
    case 'building': return live('gate') ? { pct: 60, step: 'cổng' } : { pct: 25, step: 'build' }
    case 'ready': return { pct: 80, step: 'chờ merge' }
    case 'merged': return { pct: 100, step: 'xong' }
    case 'blocked': return { pct: 0, step: 'blocked' }
  }
}

export function overallProgress(tasks: Task[], agents: AgentRec[]) {
  const counted = tasks.filter(t => t.status !== 'blocked')
  const sum = counted.reduce((s, t) => s + taskProgress(t, agents).pct, 0)
  return { pct: counted.length ? Math.round(sum / counted.length) : 0, counted: counted.length, blocked: tasks.length - counted.length }
}
