#!/usr/bin/env bash
# huu local gate — run every verification job and report a three-state summary.
#
# States:
#   PASS       green  — step succeeded
#   FAIL       red    — step failed OR its tool/script is missing
#   PENDENTE   yellow — not yet implemented (future module dependency)
#
# Exit: 0 when every step is PASS, 1 otherwise.
#
# Options:
#   --list          print step names and exit.
#   --list-from-ci  parse .github/workflows/gate.yml and print its run steps.
#                   This is the SINGLE SOURCE OF TRUTH — the gate.sh steps
#                   mirror the CI workflow; --list-from-ci reads the YAML
#                   directly so the two lists never drift.
#
# CI detection (env CI=true or GITHUB_ACTIONS=true):
#   - Colours are suppressed (tput fallback already handles this).
#   - The header reports "[CI]" so logs clearly show the environment.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GREEN=$(tput setaf 2 2>/dev/null || echo -n '')
RED=$(tput setaf 1 2>/dev/null || echo -n '')
YELLOW=$(tput setaf 3 2>/dev/null || echo -n '')
BOLD=$(tput bold 2>/dev/null || echo -n '')
RESET=$(tput sgr0 2>/dev/null || echo -n '')

# ---- colour helpers --------------------------------------------------------
colour()  { echo -n "${1}"; }
reset_c() { echo -n "${RESET}"; }

# ---- CI detection ----------------------------------------------------------
is_ci() {
  [[ "${CI:-}" == "true" ]] || [[ "${GITHUB_ACTIONS:-}" == "true" ]]
}

# ---- step registry ---------------------------------------------------------
# Each entry: "label|command|pending_flag"
#   command:      a repo-root-relative PATH (run via bash) when its FIRST token
#                 contains a slash, otherwise a command name resolved on PATH.
#                 Arguments are allowed either way.
#   pending_flag: "yes" if the step is waiting on a future module, "" otherwise
#
# A tool is missing when:
#   - pending_flag="" AND the first token is neither a repo file nor on PATH
#
# check-dockerfile is the 10th step and exists because of a HOLE, not a hunch:
# `RUN --mount=type=cache,target=/root/.npm` sat in the Dockerfile from the
# first commit and every gate step above stayed green while `npm start` could
# not build the image at all on a Docker without the buildx plugin. huu is
# docker-only, so an unbuildable image is a dead product, and no step here was
# looking at the Dockerfile.
#
# check-acceptance / validate-graph carried `pending` from W1, when their
# scripts did not exist yet ("a gate that does not exist is ANNOUNCED, never
# omitted" — METODO M1-01). W3 shipped both, so they are now WIRED with the
# arguments their own acceptance criteria specify (METODO M1-02: a selector
# that must match ≥1 test). Leaving the flag on kept the whole gate red
# forever, since any PENDENTE forces exit 1.
STEPS=(
  "typecheck|npm run typecheck|"
  "test|npm test|"
  "validate-skills|.agents/skills/meta-skill-consolidate/scripts/validate-skills.sh|"
  "check-acceptance|npx tsx scripts/check-acceptance.ts --selector requeue|"
  "smoke-defaults|scripts/smoke-defaults.sh|"
  "validate-graph|scripts/validate-graph.sh pipelines/*.pipeline.json|"
  "check-pins|npx tsx scripts/check-pins.ts|"
  "check-twins|npx tsx scripts/check-twins.ts|"
  "check-metodo|npx tsx scripts/check-metodo.ts|"
  "check-dockerfile|npx tsx scripts/check-dockerfile.ts|"
)

# ---- helpers ---------------------------------------------------------------
step_label()   { echo "${STEPS[$1]}" | cut -d'|' -f1; }
step_tool()    { echo "${STEPS[$1]}" | cut -d'|' -f2; }
step_pending() { echo "${STEPS[$1]}" | cut -d'|' -f3; }

total_steps() { echo "${#STEPS[@]}"; }

# True when the step's command can actually be run.
#
# Classify on the FIRST TOKEN only. Testing the whole string for a slash made
# every `npx tsx scripts/<x>.ts` step look like a missing file — bash checked
# for a file literally named "npx tsx scripts/<x>.ts" — and report
# "ferramenta nao encontrada" while the script sat right there on disk. That
# spurious FAIL is what kept check-twins red in CI.
tool_exists() {
  local tool="$1"
  local cmd="${tool%% *}"
  if [[ "$cmd" == */* ]]; then
    [[ -f "$REPO_ROOT/$cmd" ]] || [[ -x "$REPO_ROOT/$cmd" ]]
  else
    command -v "$cmd" >/dev/null 2>&1
  fi
}

# ---- list-from-ci mode -----------------------------------------------------
# Reads .github/workflows/gate.yml and extracts every `run:` step.
# Uses python3 for robust YAML parsing; falls back to grep/sed if unavailable.
if [[ "${1:-}" == "--list-from-ci" ]]; then
  GATE_YAML="$REPO_ROOT/.github/workflows/gate.yml"
  if [[ ! -f "$GATE_YAML" ]]; then
    echo "gate.sh: CI workflow not found at $GATE_YAML" >&2
    exit 2
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import re
with open('$GATE_YAML') as f:
    lines = f.read().splitlines()

# Emit every command a CI step runs. A 'run:' whose value is a BLOCK SCALAR
# (| or >) holds its commands on the following, more-indented lines — matching
# only the 'run:' line itself printed a bare '|' and hid the real commands,
# which defeats the point of this mode (detecting drift against STEPS above).
out = []
i = 0
while i < len(lines):
    m = re.match(r'^(\s*)-?\s*run:\s*(.*)$', lines[i])
    if not m:
        i += 1
        continue
    indent, value = len(m.group(1)), m.group(2).strip()
    if value in ('|', '>', '|-', '>-', '|+', '>+'):
        i += 1
        while i < len(lines):
            body = lines[i]
            if body.strip() and (len(body) - len(body.lstrip())) <= indent:
                break
            if body.strip():
                out.append(body.strip())
            i += 1
        continue
    if value:
        out.append(value)
    i += 1

for r in out:
    print(r)
"
  else
    # Fallback: grep for lines starting with optional dash + run: (block
    # scalars degrade to a bare '|' here — python3 is the accurate path).
    grep -E '^\s*-?\s*run:\s*' "$GATE_YAML" | sed 's/^\s*-*\s*run:\s*//'
  fi
  exit 0
fi

# ---- list mode -------------------------------------------------------------
if [[ "${1:-}" == "--list" ]]; then
  for ((i = 0; i < "${#STEPS[@]}"; i++)); do
    label="$(step_label "$i")"
    if [[ "$(step_pending "$i")" == "yes" ]]; then
      echo "$label  PENDENTE"
    else
      echo "$label"
    fi
  done
  exit 0
fi

# ---- execute ---------------------------------------------------------------
if is_ci; then
  echo "=== huu gate [CI] ==="
else
  echo "=== huu gate ==="
fi

pass=0
fail=0
pending=0

for ((i = 0; i < "${#STEPS[@]}"; i++)); do
  label="$(step_label "$i")"
  tool="$(step_tool "$i")"
  is_pending="$(step_pending "$i")"

  if [[ "$is_pending" == "yes" ]]; then
    colour "$YELLOW"
    echo "[PENDENTE] $label"
    reset_c
    pending=$((pending + 1))
    continue
  fi

  if ! tool_exists "$tool"; then
    colour "$RED"
    echo "[FAIL] $label (ferramenta nao encontrada: $tool)"
    reset_c
    fail=$((fail + 1))
    continue
  fi

  # Always run from the repo root, always through `eval` so a step may carry
  # arguments (and globs, expanded there). Path-style steps get an explicit
  # `bash` prefix; the old branch passed "<script> <args>" as ONE filename and
  # could not express an argument at all.
  set +e
  if [[ "${tool%% *}" == */* ]]; then
    (cd "$REPO_ROOT" && eval "bash $tool") 2>&1
  else
    (cd "$REPO_ROOT" && eval "$tool") 2>&1
  fi
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    colour "$GREEN"
    echo "[PASS] $label"
    reset_c
    pass=$((pass + 1))
  else
    colour "$RED"
    echo "[FAIL] $label (exit $rc)"
    reset_c
    fail=$((fail + 1))
  fi
done

# ---- summary ---------------------------------------------------------------
echo "---"

# NB: `[[ … ]] && parts+=(…)` would be the last command of the list, so on a
# FALSE test it returns 1 — and the loop above leaves `set -e` in effect, which
# killed the script right here, before the summary ever printed. It only fires
# when a counter is zero, i.e. exactly on a fully green run: the one outcome
# this gate had never produced. Written as `if` so no branch can exit.
parts=()
if [[ "$pass"    -gt 0 ]]; then parts+=("$pass PASS"); fi
if [[ "$fail"    -gt 0 ]]; then parts+=("$fail FAIL"); fi
if [[ "$pending" -gt 0 ]]; then parts+=("$pending PENDENTE"); fi

summary="$(IFS=, ; echo "${parts[*]}")"
if [[ "$fail" -gt 0 ]] || [[ "$pending" -gt 0 ]]; then
  colour "$BOLD"
  echo "$summary — exit 1"
  reset_c
  exit 1
else
  colour "$BOLD"
  echo "$summary"
  reset_c
  exit 0
fi
