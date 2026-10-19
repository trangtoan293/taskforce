// The dashboard pane: four tabs over the ledger snapshot and the live agent records.
import type { AgentRec, Board, MetricRow, Tab, Task } from '../types'
import { agentTree, overallProgress, taskProgress, totals, type Node } from './telemetry'
import { bar, clock, dur, fmtTok, pad } from './format'

// ponytail: loose element typing; the engine validates every tree it is handed.
type El = (props: Record<string, unknown>, ...children: unknown[]) => unknown
type Elements = { Box: El; Text: El; Button: El }

type Props = { agents: AgentRec[]; board: Board; tab: Tab; rows: number; setTab: (t: Tab) => void }

const TABS: [Tab, string, string][] = [
  ['overview', '1', 'Tổng quan'],
  ['tasks', '2', 'Task'],
  ['agents', '3', 'Agent'],
  ['flow', '4', 'Luồng'],
]
const STEPS = ['chờ', 'build', 'cổng', 'chờ merge', 'xong']
const STATUS_COLOR: Record<Task['status'], string> = {
  pending: 'subtle', building: 'warning', ready: 'suggestion', merged: 'success', blocked: 'error',
}
const ROLE_LABEL: Record<AgentRec['role'], string> = { main: 'master', builder: 'builder', gate: 'gate', agent: 'agent' }

// Tokens per task: finished agents come from metrics (all sessions), running ones from this session.
function taskTokens(id: string, events: MetricRow[], agents: AgentRec[]) {
  const done = events.filter(r => r.event === 'agent' && r.id === id)
  const live = agents.filter(a => a.taskId === id && a.status === 'running')
  const sum = (xs: { tokensIn?: number; tokensOut?: number }[]) => xs.reduce((s, x) => s + (x.tokensIn ?? 0) + (x.tokensOut ?? 0), 0)
  return sum(done) + sum(live)
}

export function renderPane({ Box, Text, Button }: Elements, p: Props) {
  const { board, agents } = p
  const tabs = (
    <Box flexDirection="row" gap={2}>
      {TABS.map(([id, key, label]) => (
        <Button key={`tab-${id}`} hotkey={key} label={`${key} ${label}`} dimColor={p.tab !== id} onPress={() => p.setTab(id)} />
      ))}
    </Box>
  )
  if (!board.hasLedger)
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Text dimColor>Thư mục này chưa có ledger taskforce. Mở Claude Code trong repo có taskforce.json, hoặc dùng tf action "init".</Text>
      </Box>
    )

  const body =
    p.tab === 'tasks' ? tasksTab() : p.tab === 'agents' ? agentsTab() : p.tab === 'flow' ? flowTab() : overviewTab()
  return (
    <Box flexDirection="column" gap={1}>
      {tabs}
      {body}
    </Box>
  )

  function overviewTab() {
    const { pct, counted, blocked } = overallProgress(board.tasks, agents)
    const t = totals(agents)
    const history = board.events.filter(r => r.event === 'agent')
    const histTok = history.reduce((s, r) => s + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0)
    const count = (s: Task['status']) => board.tasks.filter(x => x.status === s).length
    return (
      <Box flexDirection="column">
        <Text>Repo <Text bold>{board.repo}</Text>{board.killSwitch ? <Text color="error"> · ⛔ kill switch BẬT</Text> : <Text dimColor> · kill switch tắt</Text>}</Text>
        <Text>Tiến độ chung <Text color="success">{bar(pct, 30)}</Text> <Text bold>{pct}%</Text> <Text dimColor>(ước theo bước, {counted} task tính{blocked ? `, ${blocked} blocked không tính` : ''})</Text></Text>
        <Text>
          <Text color="subtle">chờ {count('pending')}</Text> · <Text color="warning">đang làm {count('building')}</Text> · <Text color="suggestion">chờ merge {count('ready')}</Text> · <Text color="success">xong {count('merged')}</Text> · <Text color="error">blocked {count('blocked')}</Text>
        </Text>
        <Text>Token phiên này: vào {fmtTok(t.tokensIn)} · ra {fmtTok(t.tokensOut)} · cache đọc {fmtTok(t.cacheRead)} · {t.running} agent đang chạy</Text>
        <Text dimColor>Token builder/gate tích luỹ mọi phiên: {fmtTok(histTok)} qua {history.length} lượt agent</Text>
        <Text> </Text>
        {board.tasks.map(task => {
          const pr = taskProgress(task, agents)
          return (
            <Text>
              {pad(task.id, 6)} <Text color={STATUS_COLOR[task.status]}>{bar(pr.pct, 12)}</Text> {String(pr.pct).padStart(3)}% {pad(pr.step, 10)} {pad(task.title, 36)}
            </Text>
          )
        })}
      </Box>
    )
  }

  function tasksTab() {
    return (
      <Box flexDirection="column" gap={1}>
        {board.tasks.map(task => {
          const pr = taskProgress(task, agents)
          const cur = task.status === 'blocked' ? -1 : STEPS.indexOf(pr.step)
          return (
            <Box flexDirection="column">
              <Text>
                <Text bold>{task.id}</Text> {task.title} <Text color={STATUS_COLOR[task.status]}>[{task.status}]</Text> <Text dimColor>· lần thử {task.attempts}/{task.maxAttempts ?? 3} · {fmtTok(taskTokens(task.id, board.events, agents))} tok{task.deps?.length ? ` · cần ${task.deps.join(', ')}` : ''}</Text>
              </Text>
              <Text>
                {STEPS.map((s, i) => (
                  <Text color={i === cur ? 'warning' : i < cur ? 'success' : 'subtle'} bold={i === cur}>{i ? ' → ' : '  '}{i < cur ? '✓ ' : ''}{s}</Text>
                ))}
              </Text>
              {task.lastError ? <Text color="error" wrap="truncate-end">  ⚠ {task.lastError.split('\n')[0]}</Text> : null}
            </Box>
          )
        })}
      </Box>
    )
  }

  function agentsTab() {
    const list = [...agents].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
    const now = Date.now()
    return (
      <Box flexDirection="column">
        <Text bold>{pad('', 2)}{pad('agent', 18)}{pad('vai trò', 9)}{pad('task', 6)}{pad('tool', 16)}{pad('vào', 8)}{pad('ra', 8)}{pad('cache', 8)}thời gian</Text>
        {list.slice(0, Math.max(3, p.rows - 8)).map(a => (
          <Text dimColor={a.status === 'done'}>
            <Text color={a.status === 'running' ? 'warning' : 'success'}>{a.status === 'running' ? '● ' : '✓ '}</Text>
            {pad(a.label, 18)}{pad(ROLE_LABEL[a.role], 9)}{pad(a.taskId ?? '-', 6)}{pad(`${a.tools}× ${a.lastTool ?? ''}`, 16)}{pad(fmtTok(a.tokensIn), 8)}{pad(fmtTok(a.tokensOut), 8)}{pad(fmtTok(a.cacheRead), 8)}{a.id === 'main' ? '-' : dur((a.endedAt ?? now) - a.startedAt)}
          </Text>
        ))}
        {list.length === 0 ? <Text dimColor>Chưa có agent nào trong phiên này.</Text> : null}
      </Box>
    )
  }

  function flowTab() {
    const lines: unknown[] = []
    const walk = (n: Node, prefix: string, last: boolean, root: boolean) => {
      const a = n.agent
      const info = a ? ` · ${fmtTok(a.tokensIn + a.tokensOut)} tok${a.id !== 'main' ? ` · ${a.status === 'running' ? 'đang chạy' : 'xong'}` : ''}` : ''
      lines.push(
        <Text>
          <Text dimColor>{root ? '' : `${prefix}${last ? '└─ ' : '├─ '}`}</Text>
          <Text bold={root} color={a?.status === 'running' && a.id !== 'main' ? 'warning' : undefined}>{n.label}</Text>
          <Text dimColor>{info}</Text>
        </Text>,
      )
      n.children.forEach((c, i) => walk(c, root ? '' : prefix + (last ? '   ' : '│  '), i === n.children.length - 1, false))
    }
    walk(agentTree(agents), '', true, true)
    const events = board.events.filter(r => r.event !== 'agent').slice(-Math.max(4, p.rows - lines.length - 10))
    return (
      <Box flexDirection="column">
        <Text bold>Master gọi slave</Text>
        {lines}
        <Text> </Text>
        <Text bold>Dòng thời gian</Text>
        {events.map(r => (
          <Text dimColor={r.event === 'claim'}>
            {clock(r.ts)} <Text color={r.event === 'merged' || r.event === 'pass' ? 'success' : r.event === 'claim' ? 'subtle' : 'error'}>{pad(r.event, 11)}</Text> {r.tasks?.join(', ') ?? r.id ?? ''}{r.error ? <Text dimColor> — {r.error.split('\n')[0].slice(0, 70)}</Text> : null}
          </Text>
        ))}
      </Box>
    )
  }
}
