#!/usr/bin/env bash
# Merge ready branches into BASE one at a time; re-run the gates after each merge and
# roll back on failure. Decides by exit codes only.
# usage: tf-merge.sh REPO BASE ID:BRANCH [ID:BRANCH ...] -- NAME=CMD [NAME=CMD ...]
# prints: [{"id":..,"outcome":"merged"|"merge-fail","error"?:..}, ...]
set -u
. "$(dirname "$0")/lib.sh"

repo=$1 base=$2; shift 2
tasks=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do tasks+=("$1"); shift; done
shift
gates=("$@")

result() { # id outcome [error]
  if [ $# -ge 3 ]; then
    printf '{"id":%s,"outcome":"%s","error":%s}' "$(printf '%s' "$1" | json_str)" "$2" "$(printf '%s' "$3" | json_str)"
  else
    printf '{"id":%s,"outcome":"%s"}' "$(printf '%s' "$1" | json_str)" "$2"
  fi
}

out=()
current=$(git -C "$repo" branch --show-current)
dirty=$(git -C "$repo" status --porcelain --untracked-files=no)
if [ "$current" != "$base" ] || [ -n "$dirty" ]; then
  for t in "${tasks[@]}"; do
    out+=("$(result "${t%%:*}" merge-fail "repo not ready to merge: on '$current' (need '$base'), uncommitted: ${dirty:-none}")")
  done
  printf '[%s]\n' "$(join_by_comma "${out[@]}")"
  exit 0
fi

for t in "${tasks[@]}"; do
  id=${t%%:*} branch=${t#*:}
  if ! git -C "$repo" merge --no-ff -q "$branch" -m "tf($id): merge $branch" >/dev/null 2>&1; then
    conflicts=$(git -C "$repo" diff --name-only --diff-filter=U)
    git -C "$repo" merge --abort >/dev/null 2>&1
    out+=("$(result "$id" merge-fail "merge conflict with $base in: ${conflicts:-unknown}. Rebase on $base and resolve.")")
    continue
  fi
  failed=""
  for spec in "${gates[@]}"; do
    name=${spec%%=*} cmd=${spec#*=}
    if ! run_gate "$name" "$cmd" "$repo"; then failed="[$name] $GATE_OUT"; break; fi
  done
  if [ -n "$failed" ]; then
    git -C "$repo" reset -q --hard ORIG_HEAD
    out+=("$(result "$id" merge-fail "after merging into $base: $failed")")
  else
    git -C "$repo" worktree remove --force ".tf-worktrees/$id" >/dev/null 2>&1
    out+=("$(result "$id" merged)")
  fi
done
printf '[%s]\n' "$(join_by_comma "${out[@]}")"
