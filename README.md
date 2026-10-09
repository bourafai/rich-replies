# rich-replies

A Claude Code terminal mod. It draws Claude's replies and tool calls with structure you can act on:

- **Replies:** a ◆ TL;DR box, ▶ foldable sections, a `?` badge on the closing question, language badges on code, copy buttons.
- **Shell blocks:** ▶ runs a command under its block, several runs side by side; risky commands (deletion, push, upload, `| sh`, non-GET requests) ask for a second click.
- **Tool rows:** badges and durations, a red line with the error that matters, `↗ file:line` chips that open your editor, lint results right after an Edit or Write.
- **Links, colors, images:** bare URLs as short links (a PR reads `repo #367`), a swatch next to each color, thumbnails of cited images.
- **Data:** a read-only SQL console on your local MariaDB (a `DELETE` / `UPDATE` is simulated: you see the rows it would touch, nothing is written), a REST client on `curl` lines, a foldable JSON tree.
- **Commands:** `/changes` (stage, unstage, revert, restore hunk by hunk), `/pr` (live PR card and CI checks), `/snap` (page screenshots, responsive, perf, a11y, visual diff), `/exec` (a command's output in the transcript, sent to Claude only when you click).

Everything is **off** until you turn it on.

## Install

Requires Claude Code 2.1.287 or newer (mods API).

```text
/plugin marketplace add bourafai/rich-replies
/plugin install rich-replies@rich-replies
```

Then copy the commented config and set the features you want to `true`:

```bash
cp ~/.claude/plugins/marketplaces/rich-replies/hooks/rich-replies/rich-replies.example.jsonc ~/.claude/rich-replies.jsonc
```

Features apply on your next prompt; the commands (`changesCommand`, `prCommand`, `snapCommand`, `execCommand`) on the next session. Buttons answer clicks on desktop, and in the terminal in fullscreen mode (`/tui fullscreen`; back with `/tui default`).

Not sure where to start? Ask Claude "how do I use rich replies": the bundled `rich-replies-tour` skill walks you through every feature in a sandbox, one step at a time. A visual cheat sheet lives in [`docs/rich-replies/index.html`](docs/rich-replies/index.html).

## Configuration

`~/.claude/rich-replies.jsonc` has four sections; [the example](hooks/rich-replies/rich-replies.example.jsonc) documents each key.

- `features`: `true` / `false` per feature.
- `palette` and `colors`: name your colors once (`#rrggbb`), then use them by name.
- `editor`: the CLI stack links open with (`cursor`, `code`).

A wrong key or value shows a toast and keeps its default.

## Requirements per feature

- `/snap` and `imagePreview`: a terminal with image support (Orca, iTerm2, Kitty). `/snap` also needs Chrome in `/Applications` and Node 22+.
- `sqlConsole`: a MariaDB server on `127.0.0.1:3306` (root without password; MySQL servers are not supported) and a `mariadb` (preferred) or `mysql` client in `PATH`.
- `/pr`: the GitHub CLI `gh`.
- `imagePreview` and `/snap --watch`: macOS (`sips`, `stat -f`).

## Security

`run`, `restClient` and `sqlConsole` execute what a reply suggests, on your click only. The SQL console runs reads only: one statement, inside a `READ ONLY` transaction, with client commands, executable comments, `LOAD_FILE` and `INTO OUTFILE` refused. `problems` runs the repository's own linters (`vendor/bin/phpcs`, `node_modules/.bin/eslint`): enable it on repositories you trust. `sudo` does not work with ▶ (the password prompt has no terminal and the screen freezes): run those commands in a real terminal.

## Development

```bash
claude plugin validate .
claude plugin test .
```

## Alongside other mods

rich-replies is one plugin among others. To add your own rows under tool rows (a job's live steps, say), write your own plugin: its `ui.render` hook on `ToolUse` wraps `await next(e)` and adds rows under it. Mods nest in an order no plugin picks. When your plugin sits beneath rich-replies and changes a tool row, rich-replies leaves that row to it.

## License

[MIT](LICENSE)
