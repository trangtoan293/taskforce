# Shared helpers for tf-gate.sh and tf-merge.sh. Bash + git only, no jq/python.

# JSON-encode stdin as one string.
json_str() {
  awk 'BEGIN { ORS = "" } {
    gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "")
    gsub(/[\001-\037]/, "")
    if (NR > 1) printf "\\n"
    printf "%s", $0
  }' | { printf '"'; cat; printf '"'; }
}

# run_gate NAME CMD DIR → returns the gate's exit code, prints its last 40 lines to $GATE_OUT.
run_gate() {
  local name=$1 cmd=$2 dir=$3 code
  GATE_OUT=$( (cd "$dir" && bash -c "$cmd") 2>&1 )
  code=$?
  GATE_OUT=$(printf '%s\n' "$GATE_OUT" | tail -n 40)
  return $code
}

# failure NAME TEXT → one JSON failure object.
failure() {
  printf '{"gate":%s,"output":%s}' "$(printf '%s' "$1" | json_str)" "$(printf '%s' "$2" | json_str)"
}

join_by_comma() { local IFS=,; printf '%s' "$*"; }
