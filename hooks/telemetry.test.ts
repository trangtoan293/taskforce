import { describe, expect, test } from 'claude-code/testing'
import {
  agentTree,
  onSpawn,
  onToolCall,
  onTurn,
  overallProgress,
  roleOf,
  taskProgress,
  totals,
  type AgentRec,
} from './telemetry'
import type { Task } from './ledger'

const task = (id: string, status: Task['status']): Task => ({
  id, title: id, goal: 'g', accept: ['a'], status, attempts: 1,
})

describe('roleOf', () => {
  test('reads builder/gate and the task from a workflow label', () => {
    expect(roleOf('build:t5', '')).toEqual({ role: 'builder', taskId: 't5' })
    expect(roleOf('gate:t5', '')).toEqual({ role: 'gate', taskId: 't5' })
  })
  test('falls back to the prompt, then to a plain agent', () => {
    expect(roleOf('x', 'You are a gate runner ... /r/.tf-worktrees/t9 ...')).toEqual({ role: 'gate', taskId: 't9' })
    expect(roleOf('x', 'You are the builder ... The task (t2, attempt 1)')).toEqual({ role: 'builder', taskId: 't2' })
    expect(roleOf('Explore code', 'find things')).toEqual({ role: 'agent' })
  })
})

describe('agent records', () => {
  const spawn = (agents: AgentRec[], id: string, label: string, runId?: string) =>
    onSpawn(agents, { id, parent: 'main', runId, label, prompt: '', model: 'm', at: 1000 })

  test('spawn → tool calls → turn: counts tools, adds tokens, marks the subagent done', () => {
    let a = spawn([], 'a1', 'build:t1', 'wf_1')
    a = onToolCall(a, 'a1', 'Edit')
    a = onToolCall(a, 'a1', 'Bash')
    a = onTurn(a, 'a1', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500 }, 4000)
    expect(a[0]).toMatchObject({ role: 'builder', taskId: 't1', tools: 2, lastTool: 'Bash', tokensIn: 100, tokensOut: 20, cacheRead: 500, status: 'done', endedAt: 4000 })
  })

  test('main turns accumulate on one record that never ends', () => {
    let a = onTurn([], undefined, { input_tokens: 10, output_tokens: 1 }, 1)
    a = onTurn(a, undefined, { input_tokens: 5, output_tokens: 2 }, 2)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ id: 'main', role: 'main', tokensIn: 15, tokensOut: 3, status: 'running' })
  })

  test('totals sum every agent', () => {
    let a = spawn([], 'a1', 'build:t1')
    a = onTurn(a, 'a1', { input_tokens: 100, output_tokens: 20 }, 2)
    a = onTurn(a, undefined, { input_tokens: 10, output_tokens: 1 }, 3)
    a = spawn(a, 'a2', 'gate:t1')
    expect(totals(a)).toEqual({ tokensIn: 110, tokensOut: 21, cacheRead: 0, running: 1, agents: 3 })
  })

  test('tree: main → workflow run → its agents, plain subagents straight under main', () => {
    let a = spawn([], 'b', 'build:t1', 'wf_1')
    a = spawn(a, 'g', 'gate:t1', 'wf_1')
    a = spawn(a, 'x', 'Explore code')
    a = onTurn(a, undefined, { input_tokens: 1, output_tokens: 1 }, 1)
    const tree = agentTree(a)
    expect(tree.id).toBe('main')
    expect(tree.children.map(c => c.id)).toEqual(['wf_1', 'x'])
    expect(tree.children[0].children.map(c => c.id)).toEqual(['b', 'g'])
  })
})

describe('progress', () => {
  const live = (role: AgentRec['role'], taskId: string): AgentRec => ({
    id: role, parent: 'main', label: role, role, taskId, status: 'running', tools: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, startedAt: 0,
  })

  test('step-based percent per task', () => {
    expect(taskProgress(task('a', 'pending'), [])).toEqual({ pct: 0, step: 'chờ' })
    expect(taskProgress(task('a', 'building'), [live('builder', 'a')])).toEqual({ pct: 25, step: 'build' })
    expect(taskProgress(task('a', 'building'), [live('gate', 'a')])).toEqual({ pct: 60, step: 'cổng' })
    expect(taskProgress(task('a', 'ready'), [])).toEqual({ pct: 80, step: 'chờ merge' })
    expect(taskProgress(task('a', 'merged'), [])).toEqual({ pct: 100, step: 'xong' })
    expect(taskProgress(task('a', 'blocked'), [])).toEqual({ pct: 0, step: 'blocked' })
  })

  test('overall leaves blocked tasks out and says how many', () => {
    const tasks = [task('a', 'merged'), task('b', 'pending'), task('c', 'blocked')]
    expect(overallProgress(tasks, [])).toEqual({ pct: 50, counted: 2, blocked: 1 })
    expect(overallProgress([], [])).toEqual({ pct: 0, counted: 0, blocked: 0 })
  })
})
