import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const CONFIG = JSON.stringify({ base: 'develop', gates: { test: 'python -m unittest' }, locked: ['tests/locked/**'] })

// The engine hands fs hooks absolute paths under the test's cwd (the plugin root).
const rel = (path: string) => path.replace(/^.*\/taskforce\//, '')

// In-memory files and a bottom that "runs" every tool the plugin lets through.
function stage(on: On, files: Record<string, string>) {
  on('fs.exists', async (_$, e) => ({ value: rel(e.path) in files }))
  on('fs.read', async (_$, e) => {
    if (!(rel(e.path) in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: files[rel(e.path)] }
  })
  on('fs.write', async (_$, e) => {
    files[rel(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.stat', async () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }))
  on('tool.call', async () => ({ result: 'ran' }))
  return files
}

const tf = (input: Record<string, unknown>) => ({ tool: 'mcp__taskforce__tf', ...input })

test('guard denies writes to the ledger, config and locked tests, allows the rest', async ($, on) => {
  stage(on, { 'taskforce.json': CONFIG })
  const write = (file_path: string) => $.tool.call({ tool: 'Write', file_path, content: 'x' })
  expect((await write('/repo/.taskforce/tasks.json')).deny).toContain('protected')
  expect((await write('/repo/taskforce.json')).deny).toContain('protected')
  expect((await write('/repo/.tf-worktrees/a/tests/locked/test_api.py')).deny).toContain('protected')
  expect((await write('/repo/src/app.py')).result).toBe('ran')
  const bash = await $.tool.call({ tool: 'Bash', command: 'sed -i s/1/2/ tests/locked/test_api.py' })
  expect(bash.deny).toContain('protected path')
})

test('kill switch blocks every tool, the tf tool included', async ($, on) => {
  stage(on, { 'taskforce.json': CONFIG, AGENT_STOP: '' })
  expect((await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })).deny).toContain('kill switch')
  expect((await $.tool.call(tf({ action: 'status' }))).deny).toContain('kill switch')
})

test('tf: add → next claims and hands over the workflow → report pass → next asks to merge', async ($, on) => {
  const files = stage(on, { 'taskforce.json': CONFIG })
  const added = await $.tool.call(tf({ action: 'add', tasks: [{ id: 'a', title: 'A', goal: 'g', accept: ['x'] }] }))
  expect(String(added.result)).toContain('added 1')

  const build = String((await $.tool.call(tf({ action: 'next' }))).result)
  expect(build).toStartWith('TF-BUILD')
  expect(build).toContain('taskforce:tf-run')
  expect(JSON.parse(files['.taskforce/tasks.json']).tasks[0].status).toBe('building')

  await $.tool.call(tf({ action: 'report', results: [{ id: 'a', outcome: 'pass', branch: 'tf/a' }] }))
  expect(String((await $.tool.call(tf({ action: 'next' }))).result)).toStartWith('TF-MERGE')

  await $.tool.call(tf({ action: 'report', results: [{ id: 'a', outcome: 'merged' }] }))
  expect(String((await $.tool.call(tf({ action: 'next' }))).result)).toStartWith('TF-DONE')
  expect(files['.taskforce/metrics.jsonl'].trim().split('\n')).toHaveLength(3)
})

test('tf: errors come back as a refusal the model can read', async ($, on) => {
  stage(on, {})
  expect((await $.tool.call(tf({ action: 'next' }))).deny).toContain('run tf action "init"')
})
