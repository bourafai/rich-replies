# rich-replies tour steps

Convention: **I** = what Claude does (tool or reply); **You** = what the user types or clicks. Every step runs in `/tmp/rr-tour` (step 0 of `SKILL.md`). Each step ends with "You should see", then waits for `ok` / `next`.

## 1 · Skim fast — tldr, details, questions

What it does: a long reply opens with a ◆ TL;DR frame (the gist in 1-3 lines); the detail is folded under ▶; the closing question gets a `?` badge.

I: write the step reply as the demo. It holds a real answer longer than 6 lines — for example "why `app.js` will crash in step 4" — with `::: tldr` at the top, a `::: details Root cause` block (3-4 lines) and a last line that is only a question ("Shall we move on to step 2?"). These are the markers the mod asks for in its format guide; without the features they would show raw.

You: read the reply, click ▶ to unfold / fold the section.

You should see: a rounded blue ◆ TL;DR frame; a folded violet section; an amber `?` badge before the question. Raw `::: tldr` visible = `tldr`/`details` still `false`, or no prompt sent since.

## 2 · Code and shell — codeBlocks, shellBlocks, run

What it does: code gets a language badge; a shell command gets ⧉ copy and ▶ run **below** the block; output, exit code, Rerun, → Claude (sends the output to the model); ▶ all runs a multi-line block in a single shell.

I: show three blocks:

```php
<?php
echo "PHP badge";
```

```bash
cat /tmp/rr-tour/data.json
```

```bash
cd /tmp/rr-tour
ls
git status --short
```

then a block whose target doesn't exist: `rm -rf /tmp/rr-tour/does-not-exist`.

You: click ▶ on `cat …`, then ▶ all on the 3-line block, then ▶ on the `rm` (it asks for a second click) and cancel.

You should see: `PHP` badge; `✔ exit 0` and the output under each command; `▶⚠` + confirmation on the `rm` (risky command). No button = terminal not fullscreen. Note: `sudo` doesn't work with ▶ (the password prompt freezes the screen); a command that needs it must be typed in a real terminal.

## 3 · Links, colors, images — links, colorSwatches, imagePreview

What it does: a bare URL becomes a short link (host and path; a PR reads `⎇ repo #1`); a quoted color gets a ██ square in the text, plus a swatch strip at the bottom; a quoted image path becomes a thumbnail.

I: write a reply that cites `https://www.example.com/some/long/path`, `https://github.com/bourafai/rich-replies/pull/1`, the colors #38BDF8 and #FB7185 in a plain sentence, without backticks (inside `code` there is no inline square), and the image `/tmp/rr-tour/demo.png`.

You: click a short link (opens the browser).

You should see: `example.com/some/long/path` and `⎇ rich-replies #1` as links, a color square before each color code and the swatch strip at the bottom, a `demo.png` thumbnail (terminal with images: Orca, iTerm2, Kitty; otherwise an "Open" link).

## 4 · Understand an error — toolHeaders, errorLens, stackLinks

What it does: each tool line carries a badge (SHELL, EDIT, READ…) and its duration; when a tool fails, a red `▸` line sums up the useful error and `↗ file:line` chips open the editor.

I: run the Bash tool `node app.js` (fails: `TypeError: Cannot read properties of null (reading 'name')`).

You: click a `↗ app.js:3` chip.

You should see: `$ SHELL` badge + duration in ms, red line `▸ TypeError…`, `↗ app.js:3` chips. A "Ran N shell commands" group that holds a failure unfolds on its own. The click opens `editor` (default `cursor`, changeable in step 10).

## 5 · Lint after edit — problems

What it does: after each Edit/Write, the mod runs the project linter (phpcs, eslint; otherwise `php -l`, `node --check`) and shows `✘ N` on the edit line, with → Claude to fix it.

I: edit `ok.php` to break the syntax (remove the closing brace), look at the edit line, then fix it.

You: click → Claude on the red lint (optional).

You should see: `✎ EDIT ok.php` followed by `✘ 1` with `PHP Parse error…`; after the fix, `✔`.

## 6 · Sort your changes — changesCommand

What it does: `/changes` shows the unstaged diff **hunk by hunk** with Stage, Revert (confirmation) and → Claude (sends that hunk to the model). Every action can be undone: Stage becomes Unstage, Revert becomes Restore. A clickable `git add -p`.

You: type `/changes`. Stage the first hunk (line 3), then Unstage, then Stage again. On the second one (line 38): Revert, confirm, then Restore. Finally → Claude on the second one, adding "explain this change".

I: answer about the hunk I received; then `git status --short` to check that only the first one is staged.

You should see: 2 hunks in `notes.txt`; the first goes `✔ staged` (Unstage button), comes back, goes staged again; the second goes `↺ reverted` (Restore button) then comes back intact. If the file changed around the hunk in the meantime, Restore fails with a toast and the line stays. Nothing shows = session not started from `/tmp/rr-tour`, or command not loaded (restart the session).

## 7 · Command in the transcript — execCommand, jsonViewer

What it does: `/exec <command>` runs the command and shows its output in the transcript **without the model seeing it** — until you click → Claude.

You: type `/exec git log --oneline -3`, then `/exec cat /tmp/rr-tour/data.json`.

I: say nothing about the output before the → Claude click; if asked "what is the JSON about?", I answer that I haven't seen it. After → Claude, I read it.

You should see: output in a frame with ⧉ copy and → Claude. The output of `cat data.json` is a JSON object: it shows as a foldable tree, with `{ } text` to go back to raw (and `🌳 tree` to return). The point of the feature: show data without sending it to the model.

## 8 · Local database — sqlConsole

What it does: ▶ on a ```sql block whose first line is `-- db: <database>`. Read-only, 1 query, 50 rows, local MariaDB. A `DELETE` / `UPDATE` never runs: the mod rewrites it as a `SELECT` and shows the rows it would touch (▶ simulate).

Requirements: a MariaDB server on `127.0.0.1:3306`, root without password (Docker or Homebrew; a MySQL server is not supported) and a `mariadb` (preferred) or `mysql` client in PATH; the mod tries `mariadb` then `mysql`. Before running, I show what `tour.sh db` does: `CREATE DATABASE IF NOT EXISTS rr_tour`, an `rr_tour.items` table and 4 rows (`INSERT IGNORE`) — scratch database, existing rows never overwritten.

You: run `tour.sh db`, then click ▶ on each:

```sql
-- db: rr_tour
SELECT * FROM items WHERE qty > 0
```

```sql
-- db: rr_tour
DELETE FROM items WHERE qty = 0
```

```sql
-- db: rr_tour
SELECT COUNT(*) AS total FROM items
```

You should see: a 2-row table (`alpha`, `gamma`); for the `DELETE`, a simulation notice saying 2 rows would be deleted if run, and the rows `beta`, `delta`; the `COUNT(*)` still returns `4`: nothing was deleted. "SQL client not found" = install `mariadb` (`brew install mariadb`) and put it in PATH.

## 9 · Endpoint and JSON — restClient, jsonViewer

What it does: ▶ on a simple `curl` shows status, duration, size, headers (folded) and body. A JSON body becomes a foldable tree; ```json blocks also get 🌳.

I: show

```bash
curl -s https://httpbin.org/json
```

and a ```json block with the content of `/tmp/rr-tour/data.json`.

You: click ▶ on the curl, then fold / unfold the `flags` and `posts` nodes; click 🌳 on the json block.

You should see: `GET … 200`, duration, folded headers, colored tree. A `curl -X POST` asks for a second click (`▶⚠`).

## 10 · Settings — colors, palette, editor

What it does: `colors` maps an element (tldr, details, question, shell, progress, pr, path) to a color; `palette` defines named colors as `#rrggbb`; `editor` picks the CLI used by `stackLinks`.

You: open `~/.claude/rich-replies.jsonc`, add `"mint": "#6EE7B7"` to `palette`, set `"shell": "mint"` in `colors`, save, send any message.

I: answer with a ```bash block so the change shows.

You should see: the SHELL badge in mint green from the next prompt on. Invalid value = toast `rich-replies.jsonc: …`, default kept.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `::: tldr` shown raw | feature `false`, or no prompt sent yet | `tour.sh status`, send a message |
| `/changes`, `/exec`… unknown | commands load at session start | `/exit` then `claude -c` |
| `/changes` empty | session outside `/tmp/rr-tour` | `cd /tmp/rr-tour && claude -c` |
| No ▶ ⧉ buttons | terminal not fullscreen | fullscreen, or the desktop app |
| No thumbnail / capture | terminal without image support | Orca, iTerm2, Kitty |
| `Input must be provided … --print` | `claude` started with ▶ (no TTY) | type the command in a real terminal |
| Toast at startup | invalid key or value in the config | fix the key it names |
| `/zen` unknown | zen mode removed from the mod | nothing to do; leftover `zen` keys are ignored |
| Restore / Unstage: failure toast | file changed around the hunk since | rerun `/changes` |
| Screen frozen after ▶ | `sudo` command (no TTY for the password) | Esc, then type it in a real terminal |
