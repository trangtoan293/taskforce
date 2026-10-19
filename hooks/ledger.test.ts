import { describe, expect, test } from 'claude-code/testing'
import {
  bashTouchesProtected,
  claim,
  decideNext,
  isProtectedPath,
  parseConfig,
  parseLedger,
  report,
  requeueBuilding,
  stop,
  type Ledger,
  type Task,
} from './ledger'

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `task ${id}`,
  goal: 'do it',
  accept: ['works'],
  status: 'pending',
  attempts: 0,
  ...over,
})
const ledger = (...tasks: Task[]): Ledger => ({ tasks })
const statusOf = (l: Ledger, id: string) => l.tasks.find(t => t.id === id)?.status

describe('parse', () => {
  test('ledger: rejects duplicate ids and unknown status', () => {
    expect(() => parseLedger(JSON.stringify(ledger(task('a'), task('a'))))).toThrow('duplicate')
    expect(() => parseLedger(JSON.stringify({ tasks: [{ ...task('a'), status: 'done' }] }))).toThrow('status')
    expect(parseLedger(JSON.stringify(ledger(task('a')))).tasks).toHaveLength(1)
  })

  test('config: needs at least one gate, fills defaults', () => {
    expect(() => parseConfig('{"gates":{}}')).toThrow('gate')
    const c = parseConfig('{"gates":{"test":"make test"}}')
    expect(c).toEqual({ base: 'develop', gates: { test: 'make test' }, locked: [], maxParallel: 3 })
  })
})

describe('claim', () => {
  test('takes pending tasks whose deps are merged, up to maxParallel', () => {
    const l = ledger(task('a'), task('b', { deps: ['a'] }), task('c'), task('d'))
    const { ledger: next, claimed } = claim(l, 2)
    expect(claimed.map(t => t.id)).toEqual(['a', 'c'])
    expect(statusOf(next, 'a')).toBe('building')
    expect(next.tasks.find(t => t.id === 'a')?.attempts).toBe(1)
    expect(statusOf(next, 'b')).toBe('pending')
    expect(statusOf(l, 'a')).toBe('pending') // input not mutated
  })

  test('does not run two tasks that touch the same file together', () => {
    const l = ledger(task('a', { files: ['src/x.py'] }), task('b', { files: ['src/x.py'] }), task('c', { files: ['src/y.py'] }))
    expect(claim(l, 3).claimed.map(t => t.id)).toEqual(['a', 'c'])
  })
})

describe('report', () => {
  const building = (over: Partial<Task> = {}) => ledger(task('a', { status: 'building', attempts: 1, ...over }))

  test('pass → ready with branch, merged → merged', () => {
    const r = report(building(), { id: 'a', outcome: 'pass', branch: 'tf/a' })
    expect(r.tasks[0]).toMatchObject({ status: 'ready', branch: 'tf/a' })
    expect(statusOf(report(r, { id: 'a', outcome: 'merged' }), 'a')).toBe('merged')
  })

  test('fail retries until maxAttempts, then blocks', () => {
    expect(statusOf(report(building(), { id: 'a', outcome: 'fail', error: 'test x failed' }), 'a')).toBe('pending')
    expect(statusOf(report(building({ attempts: 3 }), { id: 'a', outcome: 'fail', error: 'boom' }), 'a')).toBe('blocked')
  })

  test('the same error twice blocks early, ignoring numbers and spacing', () => {
    const l = building({ lastError: 'line 12: expected 3 got 4' })
    expect(statusOf(report(l, { id: 'a', outcome: 'fail', error: 'line 40:  expected 3 got 5' }), 'a')).toBe('blocked')
  })

  test('impossible blocks at once and keeps the reason', () => {
    const r = report(building(), { id: 'a', outcome: 'impossible', error: 'spec contradicts locked test' })
    expect(r.tasks[0]).toMatchObject({ status: 'blocked', lastError: 'impossible: spec contradicts locked test' })
  })

  test('refuses transitions that skip a state', () => {
    expect(() => report(ledger(task('a')), { id: 'a', outcome: 'pass' })).toThrow('pending')
    expect(() => report(building(), { id: 'a', outcome: 'merged' })).toThrow('building')
    expect(() => report(building(), { id: 'zz', outcome: 'pass' })).toThrow('zz')
  })
})

describe('next', () => {
  const cfg = parseConfig('{"gates":{"test":"make test"}}')

  test('merges ready tasks before building more', () => {
    const l = ledger(task('a', { status: 'ready', attempts: 1, branch: 'tf/a' }), task('b'))
    expect(decideNext(l, cfg).kind).toBe('merge')
  })

  test('builds runnable tasks, then reports done with the blocked ones', () => {
    const d = decideNext(ledger(task('a')), cfg)
    expect(d.kind).toBe('build')
    const done = decideNext(ledger(task('a', { status: 'merged' }), task('b', { status: 'blocked' })), cfg)
    expect(done).toMatchObject({ kind: 'done', blocked: ['b'] })
  })

  test('pending tasks stuck behind a blocked dep do not keep the loop alive', () => {
    const l = ledger(task('a', { status: 'blocked' }), task('b', { deps: ['a'] }))
    expect(decideNext(l, cfg)).toMatchObject({ kind: 'done', stuck: ['b'] })
  })
})

describe('recovery and stop', () => {
  test('requeue moves building back to pending without counting an attempt', () => {
    const r = requeueBuilding(ledger(task('a', { status: 'building', attempts: 2 })))
    expect(r.tasks[0]).toMatchObject({ status: 'pending', attempts: 1 })
  })

  test('stop blocks any task that is not merged', () => {
    expect(statusOf(stop(ledger(task('a', { status: 'building' })), 'a'), 'a')).toBe('blocked')
    expect(() => stop(ledger(task('a', { status: 'merged' })), 'a')).toThrow('merged')
  })
})

describe('guard matching', () => {
  const locked = ['tests/locked/**', 'docs/spec.md']

  test('ledger, config and locked paths are protected, in any worktree', () => {
    expect(isProtectedPath('/r/.taskforce/tasks.json', locked)).toBe(true)
    expect(isProtectedPath('/r/taskforce.json', locked)).toBe(true)
    expect(isProtectedPath('/r/.tf-worktrees/a/tests/locked/test_x.py', locked)).toBe(true)
    expect(isProtectedPath('/r/docs/spec.md', locked)).toBe(true)
    expect(isProtectedPath('/r/tests/test_other.py', locked)).toBe(false)
    expect(isProtectedPath('/r/src/taskforce.jsonx', locked)).toBe(false)
  })

  test('bash: flags commands naming protected paths, lets normal ones through', () => {
    expect(bashTouchesProtected('echo x > .taskforce/tasks.json', locked)).toBe(true)
    expect(bashTouchesProtected('sed -i s/a/b/ tests/locked/test_x.py', locked)).toBe(true)
    expect(bashTouchesProtected('python -m unittest discover tests', locked)).toBe(false)
    expect(bashTouchesProtected('git merge --no-ff tf/a', locked)).toBe(false)
  })
})
