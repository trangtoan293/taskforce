import { expect, test } from 'claude-code/testing'

const rel = (path: string) => path.replace(/^.*\/taskforce\//, '')
const LEDGER = JSON.stringify({
  tasks: [
    { id: 't1', title: 'Item priority', goal: 'g', accept: ['a'], status: 'merged', attempts: 1 },
    { id: 't2', title: 'Search', goal: 'g', accept: ['a'], status: 'pending', attempts: 0 },
    { id: 't4', title: 'Untitled', goal: 'g', accept: ['a'], status: 'blocked', attempts: 1, lastError: 'impossible: contradicts locked test' },
  ],
})
const METRICS = [
  { ts: '2026-10-19T06:00:00.000Z', event: 'claim', tasks: ['t1'] },
  { ts: '2026-10-19T06:01:00.000Z', event: 'agent', id: 't1', role: 'builder', agent: 'build:t1', tokensIn: 1200, tokensOut: 300 },
  { ts: '2026-10-19T06:02:00.000Z', event: 'merged', id: 't1' },
].map(r => JSON.stringify(r)).join('\n') + '\n'

test('dashboard: overview shows progress and tokens; tab keys switch to tasks and flow', async ($, on) => {
  const files: Record<string, string> = {
    'taskforce.json': '{"gates":{"t":"true"}}',
    '.taskforce/tasks.json': LEDGER,
    '.taskforce/metrics.jsonl': METRICS,
  }
  on('fs.exists', async (_$, e) => ({ value: rel(e.path) in files }))
  on('fs.read', async (_$, e) => ({ value: files[rel(e.path)] }))
  on('fs.write', async (_$, e) => { files[rel(e.path)] = e.text; return { value: undefined } })
  on('fs.stat', async () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }))
  on('tool.call', async () => ({ result: 'ran' }))

  await $.tool.call({ tool: 'mcp__taskforce__tf', action: 'status' }) // refreshes the board
  const ui = await $.ui.mount({
    plugin: 'taskforce', surface: 'terminal', component: 'Pane',
    props: { title: 'Taskforce', isFocused: true }, requestId: 'taskforce',
  })

  // merged=100, pending=0 → 50%, blocked left out
  expect((await ui.find({ text: /Tiến độ chung/ }))?.text).toContain('50%')
  expect((await ui.find({ text: /tích luỹ/ }))?.text).toContain('1.5k')

  // the guide says what to do next: one task pending → step 3, run it
  expect((await ui.find({ text: /BƯỚC TIẾP THEO/ }))?.text).toContain('chờ chạy')
  expect((await ui.find({ text: /taskforce:run/ }))).toBeDefined()

  await ui.press({ key: 'tab-tasks' })
  expect((await ui.find({ text: /contradicts locked test/ }))?.text).toContain('⚠')

  await ui.press({ key: 'tab-flow' })
  expect((await ui.find({ text: /Master → slave/ }))).toBeDefined()
  expect((await ui.find({ text: /merged/ }))?.text).toContain('t1')

  // the retry button puts the blocked task back in the queue
  await ui.press({ key: 'act-retry' })
  expect(JSON.parse(files['.taskforce/tasks.json']).tasks.find((t: { id: string }) => t.id === 't4').status).toBe('pending')
})
