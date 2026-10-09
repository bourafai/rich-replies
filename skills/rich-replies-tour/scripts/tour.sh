#!/usr/bin/env bash
# rich-replies tour helper: demo fixtures + feature switches for ~/.claude/rich-replies.jsonc.
# Usage: tour.sh setup | enable <key...|all> | disable <key...|all> | status | db | teardown
set -euo pipefail

DIR=/tmp/rr-tour
CFG="${HOME}/.claude/rich-replies.jsonc"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
EXAMPLE="$ROOT/hooks/rich-replies/rich-replies.example.jsonc"
# A boolean entry, whatever the spacing: "tldr": false, "tldr":false, "tldr" : false.
ENTRY='"[A-Za-z]+"[[:space:]]*:[[:space:]]*(true|false)'

entries() { grep -oE "$ENTRY" "$CFG" | sed -E 's/^"([A-Za-z]+)"[[:space:]]*:[[:space:]]*/\1 /'; }

ensure_cfg() {
  [ -f "$CFG" ] && return
  cp "$EXAMPLE" "$CFG"
  echo "created $CFG from the example (all off)"
}

flip() { # flip <true|false> <key...|all>
  local to=$1 from=false changed=0; shift
  [ "$to" = false ] && from=true
  ensure_cfg
  [ -f "$CFG.tour-backup" ] || cp "$CFG" "$CFG.tour-backup"
  local list=("$@")
  [ "${list[0]:-}" = all ] && list=($(entries | cut -d' ' -f1))
  for k in "${list[@]}"; do
    local now
    now=$(entries | awk -v k="$k" '$1 == k { print $2 }')
    if [ -z "$now" ]; then
      echo "unknown feature: $k"
    elif [ "$now" = "$to" ]; then
      echo "already $to: $k"
    else
      sed -i '' -E "s/(\"$k\"[[:space:]]*:[[:space:]]*)$from/\1$to/" "$CFG"
      changed=$((changed + 1))
    fi
  done
  echo "$changed feature(s) set to $to · backup: $CFG.tour-backup (restore: cp \"$CFG.tour-backup\" \"$CFG\")"
}

case "${1:-}" in
setup)
  rm -rf "$DIR" && mkdir -p "$DIR" && cd "$DIR"
  # errorLens + stackLinks: a command that fails with a stack
  printf 'const user = null\nfunction hello() {\n  return user.name\n}\nhello()\n' > app.js
  # problems: a valid file the tour breaks on purpose
  printf '<?php\n\nfunction greet(string $name): string\n{\n    return "Hello " . $name;\n}\n' > ok.php
  # restClient + jsonViewer (also /exec): JSON to read
  printf '{"site":"example","flags":{"tldr":true,"links":false},"posts":[{"id":1,"title":"One"},{"id":2,"title":"Two"}]}\n' > data.json
  # imagePreview: a real image to cite by path
  cp "$ROOT/docs/rich-replies/img/dark.png" demo.png
  # /changes: two separate unstaged hunks
  git init -q && git config user.email tour@local && git config user.name tour
  seq 1 40 | sed 's/^/line /' > notes.txt
  git add -A && git commit -qm "chore: tour baseline"
  sed -i '' -e '3s/.*/line 3 EDITED/' -e '38s/.*/line 38 EDITED/' notes.txt
  echo "fixtures ready in $DIR (git repo with 2 unstaged hunks in notes.txt)"
  ;;
enable)  shift; flip true "$@" ;;
disable) shift; flip false "$@" ;;
status)  ensure_cfg; entries | sed 's/ /: /' ;;
db)
  # Scratch database only. Rows already there are kept as they are (INSERT IGNORE), never overwritten.
  # Same client order as the mod: mariadb first, then mysql.
  sql=$(command -v mariadb || command -v mysql) || { echo "SQL client not found: install mariadb or mysql (brew install mariadb) and put it in PATH"; exit 1; }
  "$sql" -h127.0.0.1 -uroot -e "
    CREATE DATABASE IF NOT EXISTS rr_tour;
    CREATE TABLE IF NOT EXISTS rr_tour.items (id INT PRIMARY KEY, label VARCHAR(40), qty INT);
    INSERT IGNORE INTO rr_tour.items VALUES (1,'alpha',3),(2,'beta',0),(3,'gamma',7),(4,'delta',0);"
  echo "rr_tour.items ready: $("$sql" -h127.0.0.1 -uroot -N -e 'SELECT COUNT(*) FROM rr_tour.items') rows"
  ;;
teardown)
  rm -rf "$DIR"
  echo "removed $DIR. The scratch DB stays: remove it yourself once you are done (data-safety: no automatic destructive SQL)."
  ;;
*) sed -n 2,3p "$0"; exit 1 ;;
esac
