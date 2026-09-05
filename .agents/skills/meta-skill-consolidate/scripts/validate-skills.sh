#!/usr/bin/env bash
# Mechanical validation of the skill library (step 1 of meta-skill-consolidate).
# Checks, per skill dir: SKILL.md present; frontmatter name == directory;
# description 1..1024 chars (single-line descriptions assumed); body < 500
# lines and ~< 5000 tokens (bytes/4); LEARNINGS.md present; listed in
# catalog.md; .claude/skills symlink resolves. Also: every catalog entry must
# resolve to a real skill.
#
# Added checks (M2-05):
# - Closed vocabulary: LEARNINGS.md entries must match the canonical format.
# - TTL freshness: warn if skill files are >30d stale, fail if >90d.
# - Removed-backend liveness: grep SKILL.md bodies + catalog.md for a FIXED
#   historical vocabulary (pi, azure, ...) asserted as a LIVE backend.
# Exits non-zero on any violation.
set -uo pipefail

root="$(cd "$(dirname "$0")/../../../.." && pwd)"
skills="$root/.agents/skills"
fail=0
warns=0
err() { echo "FAIL[$1] $2"; fail=1; }
wrn() { echo "WARN[$1] $2"; warns=1; }

now_epoch=$(date +%s)
days_since() {
  local file_epoch
  file_epoch=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0)
  echo $(( (now_epoch - file_epoch) / 86400 ))
}

# ---- Structural checks (original) ----

for dir in "$skills"/*/; do
  name="$(basename "$dir")"
  f="$dir/SKILL.md"
  [ -f "$f" ] || { err "$name" "missing SKILL.md"; continue; }

  fmname="$(awk -F': ' '/^name:/{print $2; exit}' "$f")"
  [ "$fmname" = "$name" ] || err "$name" "frontmatter name '$fmname' != directory name"

  desc_len="$(awk '/^description:/{sub(/^description: /,""); print length($0); exit}' "$f")"
  if [ -z "${desc_len:-}" ] || [ "$desc_len" -lt 1 ] || [ "$desc_len" -gt 1024 ]; then
    err "$name" "description length ${desc_len:-0} outside 1..1024"
  fi

  lines="$(wc -l < "$f")"
  [ "$lines" -lt 500 ] || err "$name" "body $lines lines (cap 500)"

  toks=$(( $(wc -c < "$f") / 4 ))
  [ "$toks" -lt 5000 ] || err "$name" "~$toks tokens (cap 5000)"

  [ -f "$dir/LEARNINGS.md" ] || err "$name" "missing LEARNINGS.md"

  grep -q "($name/SKILL.md)" "$skills/catalog.md" || err "$name" "not listed in catalog.md"

  link="$root/.claude/skills/$name"
  { [ -L "$link" ] && [ -e "$link" ]; } || err "$name" "symlink missing or dangling in .claude/skills (run sync-skill-links.sh)"
done

# Reverse check: catalog entries must point at existing skills.
while IFS= read -r n; do
  [ -f "$skills/$n/SKILL.md" ] || err "catalog" "lists '$n' but no such skill exists"
done < <(grep -o '([a-z0-9-]*/SKILL.md)' "$skills/catalog.md" | sed 's|^(\(.*\)/SKILL.md)$|\1|')

# ---- M2-05: Closed vocabulary for LEARNINGS.md entries ----
# Canonical format: "- [YYYY-MM-DD][source:user|inference|agent][task:<slug>][probation|promoted|superseded] <fact>"
# Only validates lines that start with "- [20" (actual entry lines), skipping
# headers, comments, and boilerplate.
LEARNINGS_ENTRY_RE='^- \[20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]\]\[source:(user|inference|agent)\]\[task:[a-z0-9._-]+\]\[(probation|promoted|superseded)\] .+'

for dir in "$skills"/*/; do
  name="$(basename "$dir")"
  lf="$dir/LEARNINGS.md"
  [ -f "$lf" ] || continue
  # Only check lines after the entries marker
  past_marker=false
  while IFS= read -r line; do
    # Detect the entries-start marker
    [[ "$line" =~ ^\<\!--\ entries\ below ]] && past_marker=true && continue
    $past_marker || continue
    # Skip empty lines and HTML comments
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^\<\!\-\- ]] && continue
    # Skip non-entry lines (headings in entries section, etc.)
    [[ "$line" =~ ^# ]] && continue
    # Only check lines that start with "- [20" (actual entries)
    if [[ "$line" =~ ^-\ \[20 ]]; then
      if ! [[ "$line" =~ $LEARNINGS_ENTRY_RE ]]; then
        err "$name" "LEARNINGS entry violates closed vocabulary: '${line:0:120}...'"
      fi
    fi
  done < "$lf"
done

# ---- M2-05: TTL freshness check ----
# Warn if SKILL.md or LEARNINGS.md is >30d since last modification.
# Fail if >90d since last modification.
for dir in "$skills"/*/; do
  name="$(basename "$dir")"
  max_age=0
  for f in "$dir/SKILL.md" "$dir/LEARNINGS.md"; do
    [ -f "$f" ] || continue
    age=$(days_since "$f")
    [ "$age" -gt "$max_age" ] && max_age="$age"
  done
  if [ "$max_age" -gt 90 ]; then
    err "$name" "TTL expired: ${max_age}d since last modification (>90d cap)"
  elif [ "$max_age" -gt 30 ]; then
    wrn "$name" "TTL stale: ${max_age}d since last modification (>30d)"
  fi
done

# ---- M2-05: Removed-backend liveness check ----
# A skill BODY must not present a backend huu has REMOVED as if it were live.
#
# The previous version of this check built its grep alternation FROM the valid
# kinds extracted out of registry.ts, so it could only ever search for names
# that were already valid: its `err` branch was unreachable, and
# `AgentBackendKind = 'pi' | 'azure' | 'stub'` sat in a SKILL.md for weeks
# while this script printed OK. The vocabulary below is therefore FIXED and
# HISTORICAL — never derived from the current set. registry.ts is consulted
# only to UN-flag a name that has been re-added (then it is live again).
#
# Scope: SKILL.md bodies + catalog.md ONLY. LEARNINGS.md is a dated,
# append-only journal; a 2026-06 entry describing the `pi` backend is a correct
# record of what was true then, not a claim about today.
#
# A false positive is worse than a missed one here (`pi` is a common syllable:
# pipeline, pi-coding-agent, mapping), so only UNAMBIGUOUS liveness assertions
# fail, and any line that frames the name as past/removed is let through.
historical_kinds="pi azure azure-openai azure-foundry copilot"
registry="$root/src/orchestrator/backends/registry.ts"
removed_alt=""
if [ -f "$registry" ]; then
  valid_kinds_tmp=$(mktemp)
  grep -oE "'[a-z][a-z0-9-]*'" "$registry" | tr -d "'" | sort -u > "$valid_kinds_tmp"
  for k in $historical_kinds; do
    # Re-added to registry.ts => live again => not a historical name any more.
    grep -qxF "$k" "$valid_kinds_tmp" && continue
    removed_alt="${removed_alt}${removed_alt:+|}$k"
  done
  rm -f "$valid_kinds_tmp"
else
  removed_alt="$(echo "$historical_kinds" | tr ' ' '|')"
fi

if [ -n "$removed_alt" ]; then
  em='[`*_]*'                                   # markdown emphasis must not hide the name
  nm="${em}\b(${removed_alt})\b${em}"
  # Unambiguous "this is a LIVE backend" shapes:
  live_re="${nm}[[:space:]]+(backend|backends|agent|agents|factory|session|sessions|prompt|prompts|SDK|CLI)\b"
  live_re="${live_re}|\bbackends?/(${removed_alt})\b"            # backends/pi/
  live_re="${live_re}|--backend=(${removed_alt})\b"              # --backend=azure
  live_re="${live_re}|'(${removed_alt})'[[:space:]]*\||\|[[:space:]]*'(${removed_alt})'"  # TS union member
  live_re="${live_re}|${nm}[[:space:]]+(is|IS|are|ARE)[[:space:]]+(a|an|the)[[:space:]]+(real|live|only|default|current|user-facing|supported)"
  # Historical framing on the same line — legitimate, never a failure.
  hist_re="remov|delet|no longer|not exist|n't exist|n’t exist|never exist|gone|historic|legacy|obsolete|deprecat|former|superseded|used to|\bwas\b|\bwere\b|\bv3\.0\b|REMOVED"
  for f in "$skills"/*/SKILL.md "$skills/catalog.md"; do
    [ -f "$f" ] || continue
    if [ "$f" = "$skills/catalog.md" ]; then
      name="catalog.md"
    else
      name="$(basename "$(dirname "$f")")"
    fi
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      lineno="${hit%%:*}"
      text="${hit#*:}"
      printf '%s\n' "$text" | grep -qiE "$hist_re" && continue
      err "$name" "line $lineno asserts a REMOVED backend as live: $(printf '%s' "$text" | cut -c1-110)"
    done < <(grep -nE "$live_re" "$f" 2>/dev/null || true)
  done
fi

# ---- Report ----

if [ "$fail" -eq 0 ] && [ "$warns" -eq 0 ]; then
  echo "OK: all skills pass structural + vocabulary + TTL + removed-backend-liveness validation"
elif [ "$fail" -eq 0 ]; then
  echo "OK: all checks pass (with warnings)"
fi
exit "$fail"
