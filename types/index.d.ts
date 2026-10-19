// State contract and the shared value types. Self-contained by rule: no imports.

export type Status = 'pending' | 'building' | 'ready' | 'merged' | 'blocked'

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

export type Role = 'main' | 'builder' | 'gate' | 'agent'

export type AgentRec = {
  id: string
  parent: string
  runId?: string
  label: string
  role: Role
  taskId?: string
  model?: string
  status: 'running' | 'done'
  tools: number
  lastTool?: string
  tokensIn: number
  tokensOut: number
  cacheRead: number
  startedAt: number
  endedAt?: number
}

export type MetricRow = {
  ts: string
  event: string
  id?: string
  tasks?: string[]
  status?: string
  attempt?: number
  error?: string
  role?: string
  agent?: string
  tokensIn?: number
  tokensOut?: number
  cacheRead?: number
  ms?: number
}

export type Tab = 'overview' | 'tasks' | 'agents' | 'flow'

export type Board = {
  hasLedger: boolean
  repo: string
  tasks: Task[]
  events: MetricRow[]
  killSwitch: boolean
}

declare module 'claude-code' {
  interface PluginState {
    taskforce: { agents: AgentRec[]; board: Board; tab: Tab }
  }
}
