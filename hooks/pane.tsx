// The dashboard pane. Layout borrowed from btop / k9s / agent monitors (ATM, TmuxCC):
// a header bar, tab chips, bordered cards, status shown by colour + icon, key hints at the bottom.
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
const STATUS: Record<Task['status'], { color: string; icon: string; label: string }> = {
  pending: { color: 'subtle', icon: '○', label: 'chờ' },
  building: { color: 'warning', icon: '◐', label: 'đang làm' },
  ready: { color: 'suggestion', icon: '◑', label: 'chờ merge' },
  merged: { color: 'success', icon: '●', label: 'xong' },
  blocked: { color: 'error', icon: '✕', label: 'blocked' },
}
const ROLE: Record<AgentRec['role'], { color: string; label: string }> = {
  main: { color: 'claude', label: 'master' },
  builder: { color: 'suggestion', label: 'builder' },
  gate: { color: 'merged', label: 'gate' },
  agent: { color: 'subtle', label: 'agent' },
}

// Tokens per task: finished agents come from metrics (all sessions), running ones from this session.
function taskTokens(id: string, events: MetricRow[], agents: AgentRec[]) {
  const done = events.filter(r => r.event === 'agent' && r.id === id)
  const live = agents.filter(a => a.taskId === id && a.status === 'running')
  const sum = (xs: { tokensIn?: number; tokensOut?: number }[]) => xs.reduce((s, x) => s + (x.tokensIn ?? 0) + (x.tokensOut ?? 0), 0)
  return sum(done) + sum(live)
}

export function renderPane({ Box, Text, Button }: Elements, p: Props) {
  const { board, agents } = p
  const repoName = board.repo.split('/').pop() || '—'
  const { pct } = overallProgress(board.tasks, agents)
  const t = totals(agents)

  const card = (title: string, color: string, body: unknown, width?: string) => (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={width} flexGrow={width ? 0 : 1}>
      <Text bold color={color}>{title}</Text>
      {body}
    </Box>
  )

  const header = (
    <Box borderStyle="round" borderColor="claude" paddingX={1} justifyContent="space-between">
      <Text><Text bold color="claude">◆ TASKFORCE</Text> <Text dimColor>│</Text> {repoName}</Text>
      <Text>
        {board.killSwitch ? <Text bold color="error">⛔ DỪNG </Text> : <Text color="success">● chạy </Text>}
        <Text dimColor>│ </Text><Text bold>{pct}%</Text> <Text color="success">{bar(pct, 14)}</Text>
        <Text dimColor> │ </Text>{t.running} agent<Text dimColor> │ </Text>{fmtTok(t.tokensIn + t.tokensOut)} tok
      </Text>
    </Box>
  )

  const tabs = (
    <Box flexDirection="row" gap={1} paddingX={1}>
      {TABS.map(([id, key, label]) => (
        <Button key={`tab-${id}`} hotkey={key} onPress={() => p.setTab(id)}>
          {p.tab === id ? <Text inverse bold color="claude">{` ${key} ${label} `}</Text> : <Text dimColor>{` ${key} ${label} `}</Text>}
        </Button>
      ))}
    </Box>
  )

  const footer = (
    <Text dimColor>  1–4 chuyển tab · /tf run chạy vòng lặp · /tf stop &lt;id&gt; dừng 1 task · touch AGENT_STOP dừng tất cả</Text>
  )

  if (!board.hasLedger)
    return (
      <Box flexDirection="column">
        {header}
        {card('Chưa có ledger', 'subtle', <Text dimColor>Mở Claude Code trong repo có taskforce.json, hoặc dùng tf action "init".</Text>)}
        {footer}
      </Box>
    )

  const body = p.tab === 'tasks' ? tasksTab() : p.tab === 'agents' ? agentsTab() : p.tab === 'flow' ? flowTab() : overviewTab()
  return (
    <Box flexDirection="column">
      {header}
      {tabs}
      {body}
      {footer}
    </Box>
  )

  function taskRow(task: Task) {
    const pr = taskProgress(task, agents)
    const s = STATUS[task.status]
    return (
      <Text>
        <Text color={s.color}>{s.icon} </Text>
        <Text bold>{pad(task.id, 5)}</Text>
        {pad(task.title, 30)}
        <Text color={s.color}>{bar(pr.pct, 12)}</Text>
        <Text bold>{String(pr.pct).padStart(4)}%</Text>
        <Text dimColor>  {pad(pr.step, 10)}</Text>
      </Text>
    )
  }

  function overviewTab() {
    const { counted, blocked } = overallProgress(board.tasks, agents)
    const history = board.events.filter(r => r.event === 'agent')
    const histTok = history.reduce((s, r) => s + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0)
    const count = (s: Task['status']) => board.tasks.filter(x => x.status === s).length
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {card('Tiến độ chung', 'success', (
            <Box flexDirection="column">
              <Text><Text bold>{pct}%</Text>  <Text color="success">{bar(pct, 18)}</Text></Text>
              <Text dimColor>ước theo bước · {counted} task tính{blocked ? ` · ${blocked} blocked không tính` : ''}</Text>
            </Box>
          ), '40%')}
          {card('Task', 'warning', (
            <Box flexDirection="column">
              <Text>
                {(['merged', 'building', 'ready'] as const).map(st => <Text color={STATUS[st].color}>{STATUS[st].icon} {STATUS[st].label} {count(st)}   </Text>)}
              </Text>
              <Text>
                {(['pending', 'blocked'] as const).map(st => <Text color={STATUS[st].color}>{STATUS[st].icon} {STATUS[st].label} {count(st)}   </Text>)}
              </Text>
            </Box>
          ), '30%')}
          {card('Token', 'claude', (
            <Box flexDirection="column">
              <Text>phiên này <Text bold>{fmtTok(t.tokensIn + t.tokensOut)}</Text> <Text dimColor>(vào {fmtTok(t.tokensIn)} · ra {fmtTok(t.tokensOut)})</Text></Text>
              <Text>tích luỹ <Text bold>{fmtTok(histTok)}</Text> <Text dimColor>qua {history.length} lượt agent</Text></Text>
            </Box>
          ))}
        </Box>
        {card(`Task (${board.tasks.length})`, 'subtle', <Box flexDirection="column">{board.tasks.map(taskRow)}</Box>)}
      </Box>
    )
  }

  function tasksTab() {
    return (
      <Box flexDirection="column">
        {board.tasks.map(task => {
          const pr = taskProgress(task, agents)
          const s = STATUS[task.status]
          const cur = task.status === 'blocked' ? -1 : STEPS.indexOf(pr.step)
          return card(`${s.icon} ${task.id} · ${task.title}`, s.color, (
            <Box flexDirection="column">
              <Text>
                {STEPS.map((step, i) => (
                  <Text>
                    {i ? <Text dimColor> ─ </Text> : null}
                    <Text color={i < cur ? 'success' : i === cur ? 'warning' : 'subtle'} bold={i === cur}>{i < cur ? '✓' : i === cur ? '●' : '○'} {step}</Text>
                  </Text>
                ))}
              </Text>
              <Text dimColor>
                lần thử {task.attempts}/{task.maxAttempts ?? 3} · {fmtTok(taskTokens(task.id, board.events, agents))} tok
                {task.deps?.length ? ` · cần ${task.deps.join(', ')}` : ''}{task.branch ? ` · ${task.branch}` : ''}
              </Text>
              {task.lastError ? <Text color="error" wrap="truncate-end">⚠ {task.lastError.split('\n')[0]}</Text> : null}
            </Box>
          ))
        })}
      </Box>
    )
  }

  function agentsTab() {
    const list = [...agents].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
    const maxTok = Math.max(1, ...list.map(a => a.tokensIn + a.tokensOut))
    const now = Date.now()
    const head = (
      <Text bold dimColor>
        {'  '}{pad('agent', 16)}{pad('vai trò', 9)}{pad('task', 6)}{pad('tool gần nhất', 18)}{'token'.padStart(8)}  {pad('', 10)}{'thời gian'.padStart(9)}
      </Text>
    )
    const rows = list.slice(0, Math.max(3, p.rows - 12)).map(a => {
      const tok = a.tokensIn + a.tokensOut
      return (
        <Text dimColor={a.status === 'done' && a.id !== 'main'}>
          <Text color={a.status === 'running' ? 'warning' : 'success'}>{a.status === 'running' ? '● ' : '✓ '}</Text>
          {pad(a.label, 16)}
          <Text color={ROLE[a.role].color}>{pad(ROLE[a.role].label, 9)}</Text>
          {pad(a.taskId ?? '—', 6)}
          {pad(`${a.tools}× ${a.lastTool ?? ''}`, 18)}
          <Text bold>{fmtTok(tok).padStart(8)}</Text>  <Text color="claude">{bar((tok / maxTok) * 100, 10)}</Text>
          {(a.id === 'main' ? '—' : dur((a.endedAt ?? now) - a.startedAt)).padStart(9)}
        </Text>
      )
    })
    return card(`Agent (${t.running} đang chạy / ${list.length})`, 'suggestion', (
      <Box flexDirection="column">
        {head}
        {rows.length ? rows : <Text dimColor>Chưa có agent nào chạy trong phiên này.</Text>}
      </Box>
    ))
  }

  function flowTab() {
    const lines: unknown[] = []
    const walk = (n: Node, prefix: string, last: boolean, root: boolean) => {
      const a = n.agent
      const running = a?.status === 'running' && a.id !== 'main'
      const role = a ? ROLE[a.role] : undefined
      lines.push(
        <Text>
          <Text dimColor>{root ? '' : `${prefix}${last ? '╰─ ' : '├─ '}`}</Text>
          {a ? <Text color={running ? 'warning' : a.id === 'main' ? 'claude' : 'success'}>{running ? '● ' : a.id === 'main' ? '◆ ' : '✓ '}</Text> : <Text color="subtle">▣ </Text>}
          <Text bold={root} color={role?.color}>{n.label}</Text>
          {a ? <Text dimColor>  {fmtTok(a.tokensIn + a.tokensOut)} tok</Text> : null}
        </Text>,
      )
      n.children.forEach((c, i) => walk(c, root ? '' : prefix + (last ? '   ' : '│  '), i === n.children.length - 1, false))
    }
    walk(agentTree(agents), '', true, true)
    const events = board.events.filter(r => r.event !== 'agent').slice(-Math.max(5, p.rows - 12))
    const evColor = (e: string) => (e === 'merged' || e === 'pass' ? 'success' : e === 'claim' ? 'subtle' : 'error')
    return (
      <Box flexDirection="row">
        {card('Master → slave', 'claude', <Box flexDirection="column">{lines}</Box>, '45%')}
        {card('Dòng thời gian', 'subtle', (
          <Box flexDirection="column">
            {events.map(r => (
              <Text wrap="truncate-end">
                <Text dimColor>{clock(r.ts)} </Text>
                <Text color={evColor(r.event)}>{pad(r.event, 11)}</Text>
                <Text bold>{r.tasks?.join(', ') ?? r.id ?? ''}</Text>
                {r.error ? <Text dimColor> {r.error.split('\n')[0]}</Text> : null}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  }
}
