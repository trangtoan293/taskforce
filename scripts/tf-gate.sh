#!/usr/bin/env bash
# Gate one task's worktree. Decides by exit codes and git, never by reading output.
# usage: tf-gate.sh WORKTREE BASE [LOCKED_GLOB ...] -- NAME=CMD [NAME=CMD ...]
# prints: {"pass":bool,"failures":[{"gate":..,"output":..}]}
set -u
. "$(dirname "$0")/lib.sh"

wt=$1 base=$2; shift 2
locked=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do locked+=("$1"); shift; done
shift # the --

failures=()
for spec in "$@"; do
  name=${spec%%=*} cmd=${spec#*=}
  run_gate "$name" "$cmd" "$wt" || failures+=("$(failure "$name" "$GATE_OUT")")
done

dirty=$(git -C "$wt" status --porcelain)
[ -n "$dirty" ] && failures+=("$(failure uncommitted "$dirty")")

pathspecs=(":(glob).taskforce/**" ":(glob)taskforce.json")
for g in ${locked[@]+"${locked[@]}"}; do pathspecs+=(":(glob)$g"); done
touched=$(git -C "$wt" diff --name-only "$base"...HEAD -- "${pathspecs[@]}")
[ -n "$touched" ] && failures+=("$(failure locked "changed protected files: $touched")")

if [ ${#failures[@]} -eq 0 ]; then
  printf '{"pass":true,"failures":[]}\n'
else
  printf '{"pass":false,"failures":[%s]}\n' "$(join_by_comma "${failures[@]}")"
fi
