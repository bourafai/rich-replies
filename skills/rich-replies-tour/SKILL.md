---
name: rich-replies-tour
description: >-
  Use when the user wants to learn, try or demo the rich-replies terminal mod — "how do I use rich
  replies", "what does /changes do", "rich replies tour", "onboarding rich replies", "demo /changes",
  "comment j'utilise rich replies".
version: 0.1.0
---

# Rich replies — guided tour

Interactive onboarding for the `hooks/rich-replies` mod: one feature at a time, a real visual on screen, a command to run, an expected result. The options reference is `hooks/rich-replies/rich-replies.example.jsonc`; the static tutorial `docs/rich-replies/index.html` stays the cheat sheet.

## Rules

- **One step per turn.** Fixed format: `Step n/10 · <name>` → what it does (1 concrete sentence) → "Try" (commands in ```bash fences, one per line) → "You should see" → wait for `ok` / `next` / `skip`.
- **Targeted question** ("what does /changes do?"): jump to the matching step, never replay the whole tour. Steps 1 to 10 are independent once step 0 is done.
- **Zen mode**: removed from the mod (leftover `zen` / `zenCommand` keys are ignored without error). If asked, say so in one sentence and offer step 4 (failing tool groups unfold on their own).
- **Before / after** when the feature changes rendering (toolHeaders): first without, then with.
- **I produce the visual myself** when it comes from my reply (TL;DR, sections, fences, links, colors): the step reply IS the demo, written with the mod's markers. When it comes from tools (error, lint, `/exec`), I actually run the tool in the sandbox.
- **I can't see the screen.** Ask "what do you see?"; if nothing shows up: feature still `false` (takes effect on the next prompt), command not loaded yet (next session), buttons not clickable (fullscreen required). See `references/steps.md` § Troubleshooting.
- The config lives outside the repo (`~/.claude/rich-replies.jsonc`): never edit it myself, give the `tour.sh enable …` command to run.
- Talk to the user in their language; UI labels stay as the mod shows them (English).

## Step 0 — Setup (required)

Script: `"$CLAUDE_PLUGIN_ROOT/skills/rich-replies-tour/scripts/tour.sh"` (`setup`, `enable`, `disable`, `status`, `db`, `teardown`).

1. `tour.sh status` — feature states (the file is created from the example if missing).
2. `tour.sh setup` — builds the `/tmp/rr-tour` sandbox (crashing app, PHP file, JSON, git repo with 2 unstaged hunks).
3. `tour.sh enable all` — turns everything on; a `.tour-backup` is saved on the first run.
4. Restart Claude **from the sandbox**: `/exit` then `cd /tmp/rr-tour && claude -c`. Required: commands (`/changes`, `/exec`…) load only at session start and read the current directory. Give this command in an inert ```text fence, never ```bash: ▶ would run it without a TTY and `claude` would answer `Input must be provided either through stdin or as a prompt argument when using --print`. Tell the user to type it in a real terminal (separate tab or window, or after `/exit`).

Don't start step 1 until the user confirms they are in `/tmp/rr-tour`.

## Steps

Full detail (demo, expected result, pitfall): `references/steps.md`. Read the step's section before playing it.

| n | Step | Features |
|---|---|---|
| 1 | Skim fast: TL;DR, folded sections, question | tldr, details, questions |
| 2 | Code and shell: badges, copy, ▶ run | codeBlocks, shellBlocks, run |
| 3 | Links, colors, images | links, colorSwatches, imagePreview |
| 4 | Understand an error | toolHeaders, errorLens, stackLinks |
| 5 | Lint after edit | problems |
| 6 | Sort your changes | changesCommand |
| 7 | Run a command in the transcript | execCommand, jsonViewer |
| 8 | Query the local database | sqlConsole |
| 9 | Test an endpoint, read JSON | restClient, jsonViewer |
| 10 | Settings: colors, palette, editor | colors, palette, editor |

Off the tour, mention in one line: `/pr` (live PR card, needs `gh` and a branch with a PR: try it in a real repo).

## End of tour

Offer, without running them: `tour.sh disable <unneeded features>` (or `cp ~/.claude/rich-replies.jsonc.tour-backup ~/.claude/rich-replies.jsonc` to restore everything), then `tour.sh teardown`. The `rr_tour` scratch database (step 8) is never dropped by the script: give the drop query to the user, who runs it if they want (data-safety).

## Safety

- `run`, `restClient`, `sqlConsole` act only on click; a risky command needs a second click (`▶⚠`). The demo uses this on purpose (step 2) on a target that doesn't exist.
- `problems` runs the current repo's linters: fine in the sandbox, remind the user before enabling it elsewhere.
- Step 8: show the `CREATE` / `INSERT IGNORE` statements of `tour.sh db` (`rr_tour` database only) before asking the user to run it.
