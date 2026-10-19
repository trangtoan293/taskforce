export const meta = {
  name: 'tf-run',
  description: 'Taskforce: build each claimed task in its own git worktree, then run the DoD shell gates',
  whenToUse: 'Only when the tf tool returns TF-BUILD; pass its args unchanged.',
  phases: [
    { title: 'Build', detail: 'one builder per task, own worktree and branch' },
    { title: 'Gate', detail: 'shell gates + locked-path check, no fixing' },
  ],
}

const BUILD = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'impossible'] },
    branch: { type: 'string' },
    summary: { type: 'string', description: 'what changed, and how each acceptance criterion is covered' },
    reason: { type: 'string', description: 'when impossible: why, concretely' },
  },
  required: ['status', 'summary'],
}

const GATE = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { gate: { type: 'string' }, output: { type: 'string' } },
        required: ['gate', 'output'],
      },
    },
  },
  required: ['pass', 'failures'],
}

const { repo, base, gates, locked = [], tasks } = args
const gateList = Object.entries(gates).map(([name, cmd]) => `- ${name}: ${cmd}`).join('\n')
const lockedList = locked.length ? locked.map(g => `- ${g}`).join('\n') : '- (none)'
const wt = t => `${repo}/.tf-worktrees/${t.id}`
const branch = t => `tf/${t.id}`

const buildPrompt = t => `You are the builder for one task in ${repo}. Work only inside your worktree.

# Setup (run exactly)
- If ${wt(t)} does not exist:
  - if branch ${branch(t)} exists: git -C ${repo} worktree add .tf-worktrees/${t.id} ${branch(t)}
  - else: git -C ${repo} worktree add .tf-worktrees/${t.id} -b ${branch(t)} ${base}
- Then inside the worktree: git rebase ${base} (abort and continue from the current state if it conflicts).

# Before coding
Read ${wt(t)}/CLAUDE.md if it exists, and run git -C ${wt(t)} log --oneline -5.
Use absolute paths under ${wt(t)} for every file you read or write.

# The task (${t.id}, attempt ${t.attempt})
${t.title}
${t.goal}
Acceptance criteria, each must be met and covered by a test:
${t.accept.map((a, i) => `${i + 1}. ${a}`).join('\n')}
${t.files.length ? `Files expected to change: ${t.files.join(', ')}` : ''}
${t.lastError ? `\nThe previous attempt FAILED with:\n${t.lastError}\nFix that first.` : ''}
${t.notes ? `\nNotes from the previous attempt:\n${t.notes}` : ''}

# Rules
- Never modify these locked paths (read them, satisfy them): \n${lockedList}
- Never touch .taskforce/ or taskforce.json.
- Add or update tests for the new behaviour outside the locked paths.
- Before finishing, run these gates yourself inside the worktree and make them pass:\n${gateList}
- Commit everything on ${branch(t)}: git -C ${wt(t)} add -A && git -C ${wt(t)} commit -m "tf(${t.id}): ${t.title}"
- If the task cannot be done without breaking a locked test or the criteria contradict each other,
  do not work around it: return status "impossible" with the concrete reason.

Return status "done" with branch "${branch(t)}" and a summary mapping each acceptance criterion to the test that covers it.`

const gatePrompt = t => `You are a gate runner. Do not edit, fix or commit anything. Only run commands and report.
Worktree: ${wt(t)}  (branch ${branch(t)}, base ${base})

1. Run each gate from inside the worktree and record its exit code:
${gateList}
   For each non-zero exit, add a failure {gate: <name>, output: <last 40 lines of its output>}.
2. Run: git -C ${wt(t)} status --porcelain
   Any output → failure {gate: "uncommitted", output: <that output>}.
3. Run: git -C ${wt(t)} diff --name-only ${base}...HEAD
   Any listed file that matches one of these globs, or is under .taskforce/ or is taskforce.json → failure {gate: "locked", output: <those files>}:
${lockedList}

pass is true only when there are no failures. Report outputs verbatim, trimmed to the relevant lines.`

const results = await pipeline(
  tasks,
  t => agent(buildPrompt(t), { label: `build:${t.id}`, phase: 'Build', schema: BUILD }),
  async (b, t) => {
    if (b.status === 'impossible') return { id: t.id, outcome: 'impossible', error: b.reason || b.summary }
    const g = await agent(gatePrompt(t), { label: `gate:${t.id}`, phase: 'Gate', schema: GATE, effort: 'low' })
    if (g.pass) return { id: t.id, outcome: 'pass', branch: branch(t), notes: b.summary }
    const error = g.failures.map(f => `[${f.gate}] ${f.output}`).join('\n').slice(0, 3000)
    return { id: t.id, outcome: 'fail', branch: branch(t), error, notes: b.summary }
  },
)

// A dropped item (agent died or was skipped) still has to reach the ledger.
return results.map((r, i) => r ?? { id: tasks[i].id, outcome: 'fail', error: 'builder or gate agent died or was skipped' })
