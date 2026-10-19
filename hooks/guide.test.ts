import { expect, test } from 'claude-code/testing'
import type { AgentRec, Board, Task } from '../types'
import { nextStep } from './guide'

const task = (id: string, status: Task['status']): Task => ({ id, title: id, goal: 'g', accept: ['a'], status, attempts: 0 })
const board = (over: Partial<Board> = {}): Board => ({
  hasConfig: true, hasLedger: true, paused: false, repo: '/r', tasks: [], events: [], killSwitch: false, ...over,
})
const live: AgentRec = { id: 'x', parent: 'main', label: 'build:a', role: 'builder', taskId: 'a', status: 'running', tools: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, startedAt: 0 }

test('walks the four steps in order', () => {
  expect(nextStep(board({ hasConfig: false }), [])).toMatchObject({ step: 1, command: '/taskforce:setup' })
  expect(nextStep(board(), [])).toMatchObject({ step: 2, command: '/taskforce:plan <mô tả việc cần làm>' })
  expect(nextStep(board({ tasks: [task('a', 'pending')] }), [])).toMatchObject({ step: 3, tone: 'action', command: '/taskforce:run' })
  expect(nextStep(board({ tasks: [task('a', 'building')] }), [live])).toMatchObject({ step: 3, tone: 'wait' })
  expect(nextStep(board({ tasks: [task('a', 'merged'), task('b', 'blocked')] }), [])).toMatchObject({ step: 4, tone: 'warn' })
  expect(nextStep(board({ tasks: [task('a', 'merged')] }), [])).toMatchObject({ step: 4, tone: 'done' })
})

test('a pause wins over everything but missing setup', () => {
  expect(nextStep(board({ paused: true, tasks: [task('a', 'building')] }), [live])).toMatchObject({ tone: 'warn', command: '/tf resume' })
})
