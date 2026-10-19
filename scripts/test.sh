#!/usr/bin/env bash
# Self-check for tf-gate.sh and tf-merge.sh against a throwaway repo. Run: bash scripts/test.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fails=0
check() { if printf '%s' "$2" | grep -q -- "$3"; then echo "ok   $1"; else echo "FAIL $1: wanted [$3] in: $2"; fails=$((fails+1)); fi; }

r=$tmp/repo; mkdir -p "$r/locked"; cd "$r"
git init -q -b develop; git config user.email t@t; git config user.name t
echo "contract" > locked/spec.txt; echo "1" > app.txt
git add -A; git commit -qm base
GATES=("check=grep -q ok app.txt")

branch() { # name file content
  git worktree add -q ".tf-worktrees/$1" -b "tf/$1" develop
  printf '%s\n' "$3" > ".tf-worktrees/$1/$2"
  git -C ".tf-worktrees/$1" add -A && git -C ".tf-worktrees/$1" commit -qm "$1"
}

branch good app.txt ok
check "gate passes a good branch" "$(bash "$here/tf-gate.sh" .tf-worktrees/good develop 'locked/**' -- "${GATES[@]}")" '"pass":true'

branch bad app.txt nope
check "gate fails on a non-zero exit" "$(bash "$here/tf-gate.sh" .tf-worktrees/bad develop 'locked/**' -- "${GATES[@]}")" '"gate":"check"'

branch cheat locked/spec.txt changed
out=$(bash "$here/tf-gate.sh" .tf-worktrees/cheat develop 'locked/**' -- "true=true")
check "gate catches a locked file edit" "$out" '"gate":"locked"'

echo dirt >> .tf-worktrees/good/app.txt
check "gate catches uncommitted work" "$(bash "$here/tf-gate.sh" .tf-worktrees/good develop -- "true=true")" '"gate":"uncommitted"'
git -C .tf-worktrees/good checkout -q app.txt

branch other app.txt "ok but different" # cut from the same base as good → conflicts once good lands

check "merge lands a good branch and removes its worktree" "$(bash "$here/tf-merge.sh" "$r" develop good:tf/good -- "${GATES[@]}")" '"outcome":"merged"'
[ -d .tf-worktrees/good ] && { echo "FAIL worktree not removed"; fails=$((fails+1)); }

out=$(bash "$here/tf-merge.sh" "$r" develop other:tf/other -- "${GATES[@]}")
check "merge reports a conflict and aborts it" "$out" 'merge conflict'
check "repo is clean after the aborted merge" "$([ -z "$(git status --porcelain -uno)" ] && echo clean)" 'clean'

head=$(git rev-parse HEAD)
branch breaks note.txt x
out=$(bash "$here/tf-merge.sh" "$r" develop breaks:tf/breaks -- "never=false")
check "merge rolls back when a gate fails after merging" "$out" '"outcome":"merge-fail"'
check "rollback restored the base head" "$(git rev-parse HEAD)" "$head"

git checkout -q -b elsewhere
check "merge refuses when not on the base branch" "$(bash "$here/tf-merge.sh" "$r" develop x:tf/x -- "t=true")" 'not ready to merge'

echo; [ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
