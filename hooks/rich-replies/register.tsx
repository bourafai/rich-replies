import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, HookStream, Timer, ProcessSpawnChunk, ProcessSpawnResult, Register, RenderNode, UiPressArgument } from 'claude-code'

import type { Check, CheckState, PrCard, Problems, Run } from '../../types'
import type { Block, Config } from './parse'
import { DEFAULT_CONFIG, applyFeatures, engineLink, isSameTree, readConfig, describeTool, langStyle, cleanOutput, errorLine, findColors, findFrames, findRefs, inlineLinks, hasMarkdownStructure, splitSwatches, isRisky, parseApiCall, parseDiff, imageCells, lintLines, sqlTarget, parseTsv, markdownTable, withResponseInfo, parseHttpResponse, jsonLines, jsonFoldPaths, isOpenByDefault, parseJson, isImagePath, prChecks, parseBlocks, progressBar, shortLabel } from './parse'

// The atoms below spell the plugin id as a literal: the engine's state scan reads only string literals there.
const PLUGIN = 'rich-replies'
const MARKDOWN_LIMIT = 10000
const OUTPUT_LIMIT = 20000
const isOpenFamily = atom({ plugin: 'rich-replies', key: 'open' } as const, false)
// One member per command line (its origin): runs stay on screen side by side.
const runFamily = atom({ plugin: 'rich-replies', key: 'run' } as const, null)
// A folded run's row count, by its origin: − and + on one run leave the others as they are; null is 10.
const runRowsFamily = atom({ plugin: 'rich-replies', key: 'runRows' } as const, null)
const RUN_ROWS = 10
const durationFamily = atom({ plugin: 'rich-replies', key: 'duration' } as const, null)
const failureFamily = atom({ plugin: 'rich-replies', key: 'failure' } as const, null)
const hunkFamily = atom({ plugin: 'rich-replies', key: 'hunk' } as const, null)
const prAtom = atom({ plugin: 'rich-replies', key: 'pr' } as const, null)
const problemsFamily = atom({ plugin: 'rich-replies', key: 'problems' } as const, null)
const sqlAtom = atom({ plugin: 'rich-replies', key: 'sql' } as const, null)
const foldFamily = atom({ plugin: 'rich-replies', key: 'fold' } as const, null)
const SQL_ROWS = 50
const JSON_COLORS = { string: 'green', number: 'yellow', boolean: 'magenta', null: 'gray', open: undefined, close: undefined, folded: 'cyan' } as const
const PR_POLL_MS = 15000
const HUNK_LINES = 30
const COMMANDS = [
  { feature: 'changesCommand', name: 'changes', description: 'Unstaged diff, hunk by hunk: stage / unstage, revert / restore, → Claude' },
  { feature: 'prCommand', name: 'pr', description: "Live card of the branch's PR: checks, reviews, failing log → Claude" },
  { feature: 'execCommand', name: 'exec', description: 'Run a shell command in the transcript; its output reaches Claude only on → Claude', argumentHint: '<command>' },
] as const

const CHECK_LOOKS: Record<CheckState, [string, string]> = {
  ok: ['✔', 'green'],
  fail: ['✘', 'red'],
  pending: ['◌', 'yellow'],
  skip: ['·', 'gray'],
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'blue',
  HEAD: 'gray',
  OPTIONS: 'gray',
  POST: 'yellow',
  PUT: 'magenta',
  PATCH: 'magenta',
  DELETE: 'red',
}

// A fence longer than any backtick run inside, so code holding fences stays one block.
const fenced = (lang: string, text: string) => {
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map(run => run.length + 1)))

  return `${fence}${lang}\n${text}\n${fence}`
}

const needsConfirm = (command: string) => {
  const api = parseApiCall(command)

  return isRisky(command) || (api !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(api.method))
}

// The reply-formatting guide, one line per feature: the model only writes markers something draws.
const GUIDE: [keyof Config['features'], string][] = [
  ['tldr', '- A reply longer than about 6 lines opens with `::: tldr` ... `:::` (each marker on its own line) around the 1-3 line takeaway the person must read.'],
  ['details', '- Optional depth (rationale, logs, alternatives, long lists) goes in `::: details <short title>` ... `:::` (each marker on its own line), collapsed by default.'],
  ['shellBlocks', '- Any command a shell would execute goes in a ```bash fence, one command per line, no prompt sign, even a single command the person will run themselves: ```bash is what gives it ⧉ copy and ▶ run, ```text leaves it inert.'],
  ['codeBlocks', '- Other text meant to be copied or sent elsewhere (a message, a PR body, a config value) goes in a fence with its language: ```text, ```md, ```sql... Never a shell command: that is ```bash.'],
  ['questions', '- A question to the person is its own final paragraph ending with "?".'],
  ['links', '- File paths go in backticks: `path/to/file.ts:42`.'],
  ['sqlConsole', '- A query on the local MariaDB goes in a ```sql fence whose first line is `-- db: <database>`, one statement: a read runs with ▶; a DELETE or UPDATE runs as a simulation (the rows it would touch, nothing written), so show writes that way before anyone runs them.'],
]

// The child of each run on screen, by origin; module-level since a stream is not state data.
const streams = new Map<string, HookStream<ProcessSpawnChunk, ProcessSpawnResult>>()

function patch($: EngineInterface, origin: string, change: Partial<Run>) {
  return update($, memberOf(runFamily, { requestId: origin }), run => (run ? { ...run, ...change } : run))
}

async function stop($: EngineInterface, origin: string) {
  const stream = streams.get(origin)
  streams.delete(origin)
  await stream?.return(undefined as never)
  await patch($, origin, { status: 'stopped' })
}

async function execute($: EngineInterface, command: string, origin: string, isRest = false) {
  if (streams.has(origin)) await stop($, origin)
  await update($, memberOf(runFamily, { requestId: origin }), () => ({ command, origin, status: 'running' as const, output: '', code: null }))
  const shell = (await $.env.get('SHELL')) ?? '/bin/zsh'
  // The REST view needs curl's status line, headers and timing: asked for, the person's command untouched otherwise.
  const stream = $.process.spawn({ argv: [shell, '-lc', (isRest && withResponseInfo(command)) || command] })
  streams.set(origin, stream)
  let output = ''
  try {
    for await (const { text } of stream) {
      output = (output + cleanOutput(text)).slice(-OUTPUT_LIMIT)
      await patch($, origin, { output })
    }
    const { code } = await stream.result
    if (streams.get(origin) === stream) await patch($, origin, { status: 'done', code })
  } catch (error) {
    if (streams.get(origin) === stream) await patch($, origin, { status: 'done', code: null, output: `${output}\n${String(error)}` })
  } finally {
    if (streams.get(origin) === stream) streams.delete(origin)
  }
}

// A click on ▶ runs inline, under the command; risky commands wait there for a second, explicit click.
async function launch($: EngineInterface, command: string, origin: string, isRest: boolean) {
  if (needsConfirm(command)) {
    if (streams.has(origin)) await stop($, origin)
    await update($, memberOf(runFamily, { requestId: origin }), () => ({ command, origin, status: 'confirm' as const, output: '', code: null }))
    return
  }
  void execute($, command, origin, isRest)
}

// Closing also ends a running child: no process left running out of sight.
async function dismiss($: EngineInterface, origin: string) {
  if (streams.has(origin)) await stop($, origin)
  await update($, memberOf(runFamily, { requestId: origin }), () => null)
}

// One clear file the user edits; read at session start and before each prompt, so edits apply at the next one.
async function loadConfig($: EngineInterface): Promise<Config> {
  const path = `${await $.env.get('HOME')}/.claude/rich-replies.jsonc`
  const text = await $.fs.read(path).catch(() => null)
  if (text === null) return DEFAULT_CONFIG
  const { config, errors } = readConfig(text)
  if (errors.length > 0) $.ui.toast(`rich-replies.jsonc: ${errors.join(' · ')}`)

  return config
}

// Opens a stack frame in the editor (cursor/code take -g path:line); else copies it.
async function openInEditor($: EngineInterface, frame: { path: string; line: number }, cwd: string, editor: string) {
  const path = frame.path.startsWith('/') ? frame.path : `${cwd}/${frame.path}`
  const res = await $.process.run([editor, '-g', `${path}:${frame.line}`]).catch(() => null)
  if (res?.exitCode === 0) return
  await $.ui.copy({ text: `${path}:${frame.line}` })
  $.ui.toast(`${editor} not found: path copied`)
}

// A foldable JSON tree; each node's fold is state keyed by `base` and its path.
type Draw = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Text' | 'Button'>

async function drawJsonTree($: EngineInterface, { Box, Text, Button }: Draw, canClick: boolean, value: unknown, base: string) {
  const paths = jsonFoldPaths(value)
  const states = await Promise.all(paths.map(path => read($, memberOf(foldFamily, { requestId: `${base}:${path}` }))))
  const open = new Set(paths.filter((path, n) => states[n] ?? isOpenByDefault(path)))
  const lines = jsonLines(value, path => open.has(path))

  return (
    <Box flexDirection="column">
      {lines.map(line => {
        const glyph = line.isFoldable ? (line.kind === 'folded' ? '▶' : '▼') : ' '
        const toggle = () => update($, memberOf(foldFamily, { requestId: `${base}:${line.path}` }), value => !(value ?? isOpenByDefault(line.path)))

        return (
          <Box key={`json-${base}:${line.path}`} paddingLeft={line.depth * 2} gap={1}>
            {line.isFoldable && canClick ? <Button plain key={`fold-${base}:${line.path}`} label={glyph} onPress={toggle} /> : <Text dimColor>{glyph}</Text>}
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                {line.key !== '' && <Text color="cyan">{`${JSON.stringify(line.key)}: `}</Text>}
                <Text color={JSON_COLORS[line.kind]}>{line.text}</Text>
              </Text>
            </Box>
          </Box>
        )
      })}
      {lines.length >= 300 && <Text dimColor>… cut at 300 lines</Text>}
    </Box>
  )
}

// One hunk's patch, applied or reverse-applied to the index or the working tree: nothing else is touched.
// Revert (after the row's confirm) and Stage can be taken back by Restore and Unstage with the same patch.
const HUNK_MODES = {
  stage: { args: ['apply', '--cached', '-'], to: 'staged' },
  revert: { args: ['apply', '-R', '-'], to: 'reverted' },
  unstage: { args: ['apply', '--cached', '-R', '-'], to: null },
  restore: { args: ['apply', '-'], to: null },
} as const

async function applyHunk($: EngineInterface, cwd: string, hunkPatch: string, id: string, mode: keyof typeof HUNK_MODES) {
  const res = await $.process.run(['git', '-C', cwd, ...HUNK_MODES[mode].args], { stdin: hunkPatch }).catch(() => null)
  const isApplied = res?.exitCode === 0
  const isUndo = mode === 'unstage' || mode === 'restore'
  const gitError = res?.stderr.trim().split('\n')[0] || 'git apply failed'
  // git apply checks the hunk's context lines: a conflict there means the file moved on since, anything else is git's own error.
  const undoError = /patch (does not apply|failed)/.test(res?.stderr ?? '') ? 'the file changed around this hunk' : gitError
  if (!isApplied) $.ui.toast(isUndo ? `${mode === 'unstage' ? 'Unstage' : 'Restore'} failed: ${undoError}` : gitError)
  // A failed undo leaves the row as it was: its button stays for another try.
  if (isApplied || !isUndo) await update($, memberOf(hunkFamily, { requestId: id }), () => (isApplied ? HUNK_MODES[mode].to : 'failed'))
}

async function fetchPr($: EngineInterface, cwd: string): Promise<PrCard | null> {
  const fields = 'number,title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,latestReviews'
  const res = await $.process.run(['gh', 'pr', 'view', '--json', fields], { cwd: cwd || undefined, timeoutMs: 20000 }).catch(() => null)
  if (res?.exitCode !== 0) return null
  try {
    const raw = JSON.parse(res.stdout) as Record<string, unknown> & { latestReviews?: { author?: { login?: string }; state?: string; body?: string }[] }

    return {
      number: Number(raw.number),
      title: String(raw.title ?? ''),
      url: String(raw.url ?? ''),
      state: String(raw.state ?? ''),
      isDraft: raw.isDraft === true,
      mergeable: String(raw.mergeable ?? ''),
      reviewDecision: String(raw.reviewDecision ?? ''),
      checks: prChecks(raw.statusCheckRollup),
      reviews: (raw.latestReviews ?? []).map(review => ({
        author: review.author?.login ?? '?',
        state: review.state ?? '',
        body: (review.body ?? '').split('\n')[0]?.slice(0, 120) ?? '',
      })),
    }
  } catch {
    return null
  }
}

// The poll of the one PR card on screen; module-level since a timer is not state data.
let prTimer: Timer | null = null
const isPending = (card: PrCard | null) => card?.checks.some(check => check.state === 'pending') === true

// ponytail: one card for the session (the last /pr), polled while checks run, 10 minutes at most.
async function watchPr($: EngineInterface, cwd: string) {
  prTimer?.cancel()
  const card = await fetchPr($, cwd)
  await update($, prAtom, () => card)
  if (!isPending(card)) return card
  let ticks = 0
  const timer = $.clock.every(PR_POLL_MS, () => void refreshPr($, cwd, ++ticks >= 40))
  prTimer = timer

  return card
}

async function refreshPr($: EngineInterface, cwd: string, isLast: boolean) {
  const card = await fetchPr($, cwd)
  if (card) await update($, prAtom, () => card)
  if (isLast || (card && !isPending(card))) prTimer?.cancel()
}

// A failing check's log, its last lines, handed to the prompt.
async function sendCheckLog($: EngineInterface, cwd: string, check: Check) {
  const job = check.url.match(/\/job\/(\d+)/)?.[1]
  const res = job ? await $.process.run(['gh', 'run', 'view', '--job', job, '--log-failed'], { cwd: cwd || undefined, timeoutMs: 30000 }).catch(() => null) : null
  const log = res?.exitCode === 0 ? res.stdout.split('\n').slice(-150).join('\n') : `(log unavailable: ${check.url})`
  await $.prompt.fill({ text: `CI check \`${check.name}\` fails:\n${fenced('', cleanOutput(log))}\n`, mode: 'append' })
}

// After Edit or Write: the project's own linter when it has one (phpcs, eslint), else a syntax check.
async function lintFile($: EngineInterface, id: string, file: string) {
  const dir = file.slice(0, file.lastIndexOf('/')) || '/'
  const top = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel']).catch(() => null)
  const root = top?.exitCode === 0 ? top.stdout.trim() : dir
  const exists = async (path: string) => (await $.fs.stat(path).catch(() => null))?.kind === 'file'
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  let plan: [string, string[]] | undefined
  if (ext === 'php') plan = (await exists(`${root}/vendor/bin/phpcs`)) ? ['phpcs', [`${root}/vendor/bin/phpcs`, '--report=emacs', '-q', file]] : ['php -l', ['php', '-l', file]]
  else if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue'].includes(ext) && (await exists(`${root}/node_modules/.bin/eslint`))) plan = ['eslint', [`${root}/node_modules/.bin/eslint`, '--format', 'unix', file]]
  else if (['js', 'mjs', 'cjs'].includes(ext)) plan = ['node --check', ['node', '--check', file]]
  else if (ext === 'json') plan = ['JSON', ['node', '-e', 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))', file]]
  else if (ext === 'sh' || ext === 'bash') plan = ['bash -n', ['bash', '-n', file]]
  else if (ext === 'py') plan = ['py_compile', ['python3', '-m', 'py_compile', file]]
  if (!plan) return
  let [tool, argv] = plan
  let res = await $.process.run(argv, { cwd: root, timeoutMs: 60000 }).catch(() => null)
  // phpcs exits 3 on its own trouble (a ruleset it cannot load): the syntax check still says something.
  if (tool === 'phpcs' && res?.exitCode === 3) {
    ;[tool, argv] = ['php -l', ['php', '-l', file]]
    res = await $.process.run(argv, { cwd: root, timeoutMs: 60000 }).catch(() => null)
  }
  // eslint exits 2 on its own trouble (no config for this file): nothing to say about the file.
  if (!res || (tool === 'eslint' && res.exitCode === 2)) return
  const lines = res.exitCode === 0 ? [] : lintLines(`${res.stdout}\n${res.stderr}`)
  await update($, memberOf(problemsFamily, { requestId: id }), (): Problems => ({ tool, lines }))
}

// ▶ on a ```sql block: one reading statement, in a read-only transaction with a 10 s cap, 50 rows shown.
// A DELETE / UPDATE runs as its simulation: the SELECT of the rows it would touch, never the write.
// ponytail: a local MariaDB server as passwordless root on 127.0.0.1:3306 (the preamble is MariaDB's: max_statement_time); a config key if that ever moves.
async function runSql($: EngineInterface, origin: string, text: string) {
  const target = sqlTarget(text)
  const base = { origin, db: typeof target === 'string' ? '' : target.db, table: '', tsv: '', count: 0, ms: 0, message: '', simulation: null }
  if (typeof target === 'string') return update($, sqlAtom, () => ({ ...base, status: 'error' as const, message: target }))
  await update($, sqlAtom, () => ({ ...base, status: 'running' as const }))
  const startedAt = await $.clock.now()
  // sqlTarget reads a backslash in a string as an escape: the server must too, or `'a\\'` would end early and let a `;` through.
  const statement = `SET SESSION max_statement_time = 10; SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', ''); START TRANSACTION READ ONLY; ${target.query}; ROLLBACK;`
  const argv = (client: string, ...extra: string[]) => [client, '-h', '127.0.0.1', '-P', '3306', '-u', 'root', '--batch', ...extra, '--safe-updates', `--select-limit=${SQL_ROWS + 1}`, `--database=${target.db}`, '-e', statement]
  const run = (args: string[]) => $.process.run(args, { timeoutMs: 20000 }).catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  // The mariadb client first, with its --sandbox; the mysql client (Homebrew mysql-client) when mariadb is absent,
  // with --binary-mode, which turns its client commands (\! shell, \. source…) off in a non-interactive run.
  // sqlTarget refuses them too and keeps one statement: the READ ONLY transaction alone would not, DDL commits on its own.
  let res = await run(argv('mariadb', '--sandbox'))
  if (res.exitCode !== 0 && /ENOENT/.test(res.stderr)) res = await run(argv('mysql', '--binary-mode'))
  const ms = (await $.clock.now()) - startedAt
  if (res.exitCode !== 0) {
    const message = /ENOENT/.test(res.stderr)
      ? 'SQL client not found: install mariadb or mysql (brew install mariadb) and put it in PATH'
      : (res.stderr.split('\n').find(line => /^ERROR/.test(line)) ?? res.stderr.trim().split('\n').at(-1) ?? 'failed')
    return update($, sqlAtom, () => ({ ...base, status: 'error' as const, ms, message }))
  }
  const parsed = parseTsv(res.stdout)
  const simulates = target.simulates
  // The simulation's first column is the window count of every row touched: a figure, not a column to show.
  const [columns, rows] = simulates ? [parsed.columns.slice(1), parsed.rows.map(row => row.slice(1))] : [parsed.columns, parsed.rows]
  const table = columns.length > 0 && rows.length > 0 ? markdownTable(columns, rows, SQL_ROWS) : ''
  const simulation = simulates ? { verb: simulates.verb, touched: Number(parsed.rows[0]?.[0] ?? 0), hasWhere: simulates.hasWhere } : null
  await update($, sqlAtom, () => ({ ...base, status: 'done' as const, ms, table, tsv: res.stdout, count: rows.length, simulation }))
}

// Image paths as PNG thumbnails: PNGs as they are, other formats through macOS sips, once per path.
const thumbs = new Map<string, { png: string; width: number; height: number } | null>()

async function thumbnail($: EngineInterface, path: string) {
  if (thumbs.has(path)) return thumbs.get(path) ?? null
  const size = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path]).catch(() => null)
  const width = Number(size?.stdout.match(/pixelWidth: (\d+)/)?.[1] ?? 0)
  const height = Number(size?.stdout.match(/pixelHeight: (\d+)/)?.[1] ?? 0)
  let png = path
  if (width > 0 && !/\.png$/i.test(path)) {
    png = `/tmp/rich-replies-thumb-${thumbs.size}-${await $.clock.now()}.png`
    const res = await $.process.run(['sips', '-Z', '640', '-s', 'format', 'png', path, '--out', png]).catch(() => null)
    if (res?.exitCode !== 0) png = ''
  }
  const thumb = width > 0 && png ? { png, width, height } : null
  thumbs.set(path, thumb)

  return thumb
}

export const register: Register = on => {
  let isOff = false
  let cwd = ''
  let config = DEFAULT_CONFIG

  on('session.start', async ($, e, next) => {
    // https://no-color.org: any non-empty value turns color off.
    isOff = Boolean(await $.env.get('NO_COLOR'))
    cwd = e.cwd
    config = await loadConfig($)
    // Commands register once per session: switching one on takes a new session.
    for (const { feature, ...command } of COMMANDS) {
      if (config.features[feature]) await $.command.register(command).catch(() => $.ui.toast(`rich-replies: /${command.name} refused`))
    }

    return next(e)
  })

  on('command.run', { command: 'changes' }, async $ => {
    const res = await $.process.run(['git', '-C', cwd, 'diff', '--no-color', '--no-ext-diff'], { timeoutMs: 20000 }).catch(() => null)
    if (res?.exitCode !== 0) return { text: `git diff failed: ${res?.stderr.trim() ?? 'no git repository here'}` }

    return { text: res.stdout.trim() === '' ? 'No unstaged changes.' : fenced('diff', res.stdout.slice(0, OUTPUT_LIMIT * 3)) }
  })

  on('command.run', { command: 'pr' }, async $ => {
    const card = await watchPr($, cwd)

    return { text: card ? `PR #${card.number} ${card.title}\n${card.url}` : 'No PR for this branch (gh pr view).' }
  })

  // The model reads only the run id: the output stays on screen until → Claude sends it.
  let execs = 0
  on('command.run', { command: 'exec' }, async ($, e) => {
    // A shell run outside Bash's permissions: only the person's own Enter starts one, never a peer, schedule or plugin.
    if (e.origin.kind !== 'composer') return { text: '/exec: keyboard input only.' }
    const command = e.args.trim()
    if (command === '') return { text: 'Usage: /exec <command>' }
    const origin = `exec #${++execs}`
    void execute($, command, origin)

    return { text: origin }
  })

  // The commands answer text (what any surface shows); the terminal and desktop draw it live.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const isDrawable = e.surface === 'terminal' || e.surface === 'desktop'
    if (isOff || !isDrawable || e.props.isErrored) return next(e)
    const canClick = e.surface === 'desktop' || e.viewport?.isFullscreen === true
    const { Box, Text, Button, Link } = $.ui.resolve(e)

    if (e.props.command === 'changes') {
      const files = parseDiff(e.props.text.replace(/^`{3,}diff\n/, '').replace(/\n`{3,}$/, '\n'))
      if (files.length === 0) return next(e)
      const lineColor = (line: string) => (line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : undefined)

      return (
        <Box flexDirection="column" gap={1}>
          {await Promise.all(
            files.map(async (file, f) => (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text bold color={config.colors.path}>{file.file}</Text>
                  <Text dimColor>{`· ${file.hunks.length} hunk${file.hunks.length > 1 ? 's' : ''}`}</Text>
                </Box>
                {await Promise.all(
                  file.hunks.map(async (hunk, n) => {
                    const id = `${e.requestId}:${f}-${n}`
                    const member = memberOf(hunkFamily, { requestId: id })
                    const state = await read($, member)
                    const [head = '', ...body] = hunk.replace(/\n$/, '').split('\n')
                    const hunkPatch = file.header + hunk

                    return (
                      <Box flexDirection="column" borderStyle="single" borderColor={state === 'staged' ? 'green' : 'gray'} paddingX={1}>
                        <Box gap={1}>
                          <Text dimColor>{head}</Text>
                          {state === 'staged' && <Text bold color="green">✔ staged</Text>}
                          {state === 'reverted' && <Text bold color="gray">↺ reverted</Text>}
                          {canClick && state === 'staged' && <Button key={`hunk-unstage-${id}`} label="Unstage" onPress={() => applyHunk($, cwd, hunkPatch, id, 'unstage')} />}
                          {canClick && state === 'reverted' && <Button key={`hunk-restore-${id}`} label="Restore" onPress={() => applyHunk($, cwd, hunkPatch, id, 'restore')} />}
                          {state === 'failed' && <Text bold color="red">✘ git apply failed</Text>}
                          {state === 'confirm' && <Text bold color="red">⚠ Discard these lines?</Text>}
                          {canClick && state === null && <Button key={`hunk-stage-${id}`} label="Stage" onPress={() => applyHunk($, cwd, hunkPatch, id, 'stage')} />}
                          {canClick && state === null && <Button key={`hunk-revert-${id}`} label="Revert" onPress={() => update($, member, () => 'confirm')} />}
                          {canClick && state === 'confirm' && <Button key={`hunk-yes-${id}`} variant="primary" label="Revert" onPress={() => applyHunk($, cwd, hunkPatch, id, 'revert')} />}
                          {canClick && state === 'confirm' && <Button key={`hunk-no-${id}`} label="Cancel" onPress={() => update($, member, () => null)} />}
                          {canClick && (
                            <Button plain key={`hunk-claude-${id}`} label="→ Claude" onPress={() => $.prompt.fill({ text: `Hunk of \`${file.file}\`:\n${fenced('diff', hunk.trimEnd())}\n`, mode: 'append' })} />
                          )}
                        </Box>
                        {state !== 'reverted' && body.slice(0, HUNK_LINES).map(line => <Text color={lineColor(line)} dimColor={!lineColor(line)}>{line || ' '}</Text>)}
                        {state !== 'reverted' && body.length > HUNK_LINES && <Text dimColor>{`… ${body.length - HUNK_LINES} lines`}</Text>}
                      </Box>
                    )
                  }),
                )}
              </Box>
            )),
          )}
        </Box>
      )
    }

    if (e.props.command === 'pr') {
      const card = await read($, prAtom)
      if (!card) return next(e)
      const color = card.isDraft ? 'gray' : { OPEN: 'green', MERGED: config.colors.pr, CLOSED: 'red' }[card.state] ?? 'gray'
      const done = card.checks.filter(check => check.state !== 'pending').length
      const review = { APPROVED: ['✔ approved', 'green'], CHANGES_REQUESTED: ['✘ changes requested', 'red'], REVIEW_REQUIRED: ['◌ review required', 'yellow'] }[card.reviewDecision]

      return (
        <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
          <Box gap={1}>
            <Text bold color="black" backgroundColor={color}>{` ${card.isDraft ? 'DRAFT' : card.state} `}</Text>
            <Text bold color={color}>
              <Link href={card.url}>{`#${card.number}`}</Link>
            </Text>
            <Box flexShrink={1}>
              <Text wrap="truncate-end">{card.title}</Text>
            </Box>
          </Box>
          <Box gap={2}>
            {card.mergeable === 'CONFLICTING' && <Text color="red">✘ conflicts</Text>}
            {card.mergeable === 'MERGEABLE' && <Text color="green">✔ mergeable</Text>}
            {review && <Text color={review[1]}>{review[0]}</Text>}
            {card.checks.length > 0 && <Text color={config.colors.progress}>{progressBar((done / card.checks.length) * 100)}</Text>}
            {card.checks.length > 0 && <Text bold>{`${done}/${card.checks.length} checks`}</Text>}
            {canClick && <Button plain key={`pr-refresh-${e.requestId}`} label="↻" onPress={() => watchPr($, cwd)} />}
          </Box>
          {card.checks.map((check, n) => (
            <Box key={`pr-check-${n}`} gap={1}>
              <Text bold color={CHECK_LOOKS[check.state][1]}>{CHECK_LOOKS[check.state][0]}</Text>
              <Text dimColor={check.state !== 'fail'}>{check.name}</Text>
              {canClick && check.state === 'fail' && <Button key={`pr-log-${e.requestId}-${n}`} variant="primary" label="→ Claude" onPress={() => sendCheckLog($, cwd, check)} />}
            </Box>
          ))}
          {card.reviews.map((item, n) => (
            <Text key={`pr-review-${n}`} dimColor>{`${item.author} · ${item.state}${item.body ? ` · ${item.body}` : ''}`}</Text>
          ))}
        </Box>
      )
    }

    if (e.props.command === 'exec') {
      // The row's text may carry the plugin's name before the id. No run under that id: the row stays plain.
      const origin = e.props.text.match(/exec #\d+/)?.[0]
      const run = origin ? await read($, memberOf(runFamily, { requestId: origin })) : null
      if (!origin || !run) return next(e)
      // /exec opens expanded: every line kept, up to OUTPUT_LIMIT characters.
      const expandMember = memberOf(foldFamily, { requestId: `${origin}:expanded` })
      const isExpanded = (await read($, expandMember)) ?? true
      const rowsMember = memberOf(runRowsFamily, { requestId: origin })
      const rows = isExpanded ? Infinity : ((await read($, rowsMember)) ?? RUN_ROWS)
      const lines = run.output.replace(/\n$/, '').split('\n')
      // A clean run whose whole output is one JSON object or array draws as the tree; { } text brings the raw lines back.
      const parsed = config.features.jsonViewer && run.status === 'done' && run.code === 0 ? parseJson(run.output) : undefined
      const json = parsed && typeof parsed.value === 'object' && parsed.value !== null ? parsed : undefined
      const rawMember = memberOf(isOpenFamily, { requestId: `${origin}:raw` })
      const isTree = json !== undefined && !(await read($, rawMember))
      const status = {
        confirm: null,
        running: <Text color="yellow">◌ running…</Text>,
        stopped: <Text dimColor>■ stopped</Text>,
        done: run.code === 0 ? <Text bold color="green">✔ exit 0</Text> : <Text bold color="red">{`✘ exit ${run.code ?? '?'}`}</Text>,
      }[run.status]
      const toClaude = () => $.prompt.fill({ text: `Output of \`${run.command}\` (exit ${run.code ?? '?'}):\n${fenced('', run.output.slice(-4000))}\n`, mode: 'append' })
      const copy = async (press: UiPressArgument) => $.ui.toast((await $.ui.copy({ text: run.output, surface: press.surface })).isCopied ? 'Copied' : 'Cannot copy here')
      const resize = (by: number) => () => update($, rowsMember, n => Math.min(60, Math.max(5, (n ?? RUN_ROWS) + by)))

      return (
        <Box flexDirection="column" borderStyle="round" borderColor={config.colors.shell} paddingX={1}>
          <Box gap={2}>
            <Text bold color="black" backgroundColor={config.colors.shell}> EXEC </Text>
            <Box flexShrink={1}>
              <Text wrap="truncate-end">{run.command}</Text>
            </Box>
            {status}
            {canClick && run.status === 'running' && <Button key={`run-stop-${origin}`} label="Stop" onPress={() => stop($, origin)} />}
            {canClick && run.status !== 'running' && <Button key={`run-again-${origin}`} label="Rerun" onPress={() => execute($, run.command, origin)} />}
            {canClick && run.status === 'done' && <Button key={`run-copy-${origin}`} label="Copy" onPress={copy} />}
            {canClick && run.status === 'done' && <Button key={`run-claude-${origin}`} variant="primary" label="→ Claude" onPress={toClaude} />}
            {canClick && json && <Button plain key={`run-tree-${origin}`} label={isTree ? '{ } text' : '🌳 tree'} onPress={() => update($, rawMember, value => !value)} />}
            {canClick && !isTree && <Button plain key={`run-expand-${origin}`} label={isExpanded ? '⤡' : '⤢'} onPress={() => update($, expandMember, () => !isExpanded)} />}
            {canClick && !isTree && !isExpanded && <Button plain key={`run-less-${origin}`} label="−" onPress={resize(-5)} />}
            {canClick && !isTree && !isExpanded && <Button plain key={`run-more-${origin}`} label="+" onPress={resize(5)} />}
            {canClick && <Button plain key={`run-close-${origin}`} label="✕" onPress={() => dismiss($, origin)} />}
          </Box>
          {isTree && json && (await drawJsonTree($, { Box, Text, Button }, canClick, json.value, `${origin}:json`))}
          {!isTree && lines.length > rows && <Text dimColor>{`… ${lines.length - rows} lines above`}</Text>}
          {!isTree && run.output !== '' && lines.slice(-rows).map(line => <Text>{line || ' '}</Text>)}
        </Box>
      )
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    config = await loadConfig($)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (isOff || !GUIDE.some(([feature]) => config.features[feature])) return result
    const surfaces = await $.session.surfaces()
    const isDrawn = surfaces.some(s => s === 'terminal' || s === 'desktop')
    const lines = GUIDE.filter(([feature]) => config.features[feature]).map(([, line]) => line)
    if (isOff || !isDrawn || lines.length === 0) return result
    const text = ["# Reply formatting\nThe person's terminal renders these conventions; follow them, never mention them.", ...lines].join('\n')

    return { sections: [...result.sections, { id: `${PLUGIN}:markers`, text, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const isDrawable = e.surface === 'terminal' || e.surface === 'desktop'
    if (isOff || !isDrawable || e.props.text.length > MARKDOWN_LIMIT) return next(e)

    // Bare URLs become short links before anything draws, so a plugin beneath sees them as links.
    const linked = config.features.links ? { ...e, props: { ...e.props, text: inlineLinks(e.props.text) } } : e
    const below = await next(linked)
    // A plugin beneath may rewrite the text too (icons on links, say): this hook draws it as it reached the engine.
    // One that answered without the engine drew the reply itself: its drawing stands.
    const engine = engineLink(next.trace)
    if (!engine) return below
    const text = (engine.received as typeof e).props.text
    const blocks = applyFeatures(parseBlocks(text), config.features)
    const swatches = config.features.colorSwatches ? findColors(text) : []
    const imageRefs = config.features.imagePreview && e.surface === 'terminal' ? findRefs(text).filter(ref => isImagePath(ref.text)).slice(0, 4) : []
    if (swatches.length === 0 && imageRefs.length === 0 && blocks.every(b => b.type === 'markdown')) return below

    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    // Clicks reach the transcript only in the fullscreen terminal and on desktop.
    const canClick = e.surface === 'desktop' || e.viewport?.isFullscreen === true
    const copy = (text: string) => async (press: UiPressArgument) => {
      const { isCopied } = await $.ui.copy({ text, surface: press.surface })
      $.ui.toast(isCopied ? 'Copied' : 'Cannot copy here')
    }
    const prose = (linked: string, dimColor?: boolean) => {
      const paragraphs = linked.split(/\n{2,}/)
      // Paragraph by paragraph, plain prose as runs, the rest as Markdown; but a block holding Markdown structure
      // (a list, a fence, a reference link defined further down) stays one Markdown, its colors in the band only.
      if (!config.features.colorSwatches || findColors(linked, 1).length === 0 || paragraphs.some(hasMarkdownStructure)) return <Markdown text={linked} dimColor={dimColor} />

      return (
        <Box flexDirection="column" gap={1}>
          {paragraphs.map((paragraph, n) => {
            const parts = splitSwatches(paragraph)
            if (!parts) return <Markdown key={`prose-${n}`} text={paragraph} dimColor={dimColor} />

            return (
              <Text key={`prose-${n}`} dimColor={dimColor}>
                {parts.map((part, m) => (part.hex ? <Text key={`sw-${m}`} color={part.hex}>██ </Text> : part.text))}
              </Text>
            )
          })}
        </Box>
      )
    }

    const jsonTree = (value: unknown, base: string) => drawJsonTree($, { Box, Text, Button }, canClick, value, base)

    // Keys and state ids carry the block's path, so blocks nested in a details stay unique.
    const renderBlocks = (list: Block[], prefix: string, dim = false): Promise<RenderNode[]> =>
      Promise.all(
      list.map(async (block, n) => {
        const i = `${prefix}${n}`
        switch (block.type) {
          case 'markdown':
            return prose(block.text, dim)

          case 'tldr':
            return (
              <Box flexDirection="column" borderStyle="round" borderColor={config.colors.tldr} paddingX={1}>
                <Box gap={1}>
                  <Text bold color={config.colors.tldr}>◆ TL;DR</Text>
                  {canClick && <Button plain key={`tldr-copy-${i}`} label="⧉ copy" onPress={copy(block.text)} />}
                </Box>
                {prose(block.text)}
              </Box>
            )

          case 'details': {
            const size = `${block.text.split('\n').length} lines`
            const open = memberOf(isOpenFamily, { requestId: `${e.requestId}:${i}` })
            const isOpen = !canClick || (await read($, open))
            const inner = isOpen ? await renderBlocks(applyFeatures(parseBlocks(block.text), config.features), `${i}.`, true) : []
            const header = (
              <Text bold color={config.colors.details}>
                {isOpen ? '▼' : '▶'} {block.title}
              </Text>
            )

            return (
              <Box flexDirection="column">
                <Box gap={1}>
                  {canClick ? (
                    <Button
                      variant="primary"
                      key={`details-${i}`}
                      label={`${isOpen ? '▼' : '▶'} ${block.title}`}
                      onPress={() => update($, open, value => !value)}
                    />
                  ) : (
                    header
                  )}
                  <Text dimColor>· {size}</Text>
                </Box>
                {isOpen && (
                  <Box flexDirection="column" gap={1} paddingLeft={2}>
                    {inner}
                  </Box>
                )}
              </Box>
            )
          }

          case 'command': {
            const runBox = async (command: string, origin: string) => {
              const run = await read($, memberOf(runFamily, { requestId: origin }))
              if (!canClick || !run) return null
              const rowsMember = memberOf(runRowsFamily, { requestId: origin })
              const collapsedRows = (await read($, rowsMember)) ?? RUN_ROWS
              const resize = (by: number) => () => update($, rowsMember, n => Math.min(60, Math.max(5, (n ?? RUN_ROWS) + by)))
              // ▶ opens expanded, like /exec, and stays so when another command runs; ⤡ folds to the last rows.
              const expandMember = memberOf(foldFamily, { requestId: `${origin}:expanded` })
              const isExpanded = (await read($, expandMember)) ?? true
              const rows = isExpanded ? Infinity : collapsedRows
              const rerun = () => execute($, command, origin, config.features.restClient)
              const toClaude = () =>
                $.prompt.fill({
                  text: `Output of \`${command}\` (exit ${run.code ?? '?'}):\n\`\`\`\n${run.output.slice(-4000)}\n\`\`\`\n`,
                  mode: 'append',
                })
              const lines = run.output.replace(/\n$/, '').split('\n')
              const shown = lines.slice(-rows)
              const http = config.features.restClient && run.status === 'done' ? parseHttpResponse(run.output) : undefined
              const headersMember = memberOf(isOpenFamily, { requestId: `${origin}:headers` })
              const areHeadersOpen = http ? await read($, headersMember) : false
              const json = http && config.features.jsonViewer ? parseJson(http.body) : undefined
              const bodyLines = http ? http.body.replace(/\n$/, '').split('\n') : []
              const statusColor = !http ? 'gray' : http.status >= 500 ? 'red' : http.status >= 400 ? 'yellow' : http.status >= 300 ? 'cyan' : 'green'
              const restView = http && (
                <Box flexDirection="column">
                  <Box gap={2}>
                    <Text bold color="black" backgroundColor={statusColor}>{` ${http.status} ${http.statusText} `.replace(/\s+ $/, ' ')}</Text>
                    <Text>{http.ms >= 1000 ? `${(http.ms / 1000).toFixed(1)} s` : `${http.ms} ms`}</Text>
                    <Text dimColor>{http.bytes >= 1000 ? `${(http.bytes / 1000).toFixed(1)} ko` : `${http.bytes} o`}</Text>
                    <Button plain key={`rest-headers-${origin}`} label={`${areHeadersOpen ? '▼' : '▶'} headers (${http.headers.length})`} onPress={() => update($, headersMember, value => !value)} />
                  </Box>
                  {areHeadersOpen &&
                    http.headers.map(([name, value]) => (
                      <Box gap={1} paddingLeft={2}>
                        <Text color="cyan">{`${name}:`}</Text>
                        <Box flexShrink={1}>
                          <Text wrap="truncate-end">{value}</Text>
                        </Box>
                      </Box>
                    ))}
                  {json ? await jsonTree(json.value, `${origin}:body`) : bodyLines.slice(0, rows).map(line => <Text>{line || ' '}</Text>)}
                  {!json && bodyLines.length > rows && <Text dimColor>{`… ${bodyLines.length - rows} more lines`}</Text>}
                </Box>
              )
              const status = {
                confirm: <Text bold color="red">⚠ Risky command. Run it?</Text>,
                running: <Text color="yellow">◌ running…</Text>,
                stopped: <Text dimColor>■ stopped</Text>,
                done: run.code === 0 ? <Text bold color="green">✔ exit 0</Text> : <Text bold color="red">{`✘ exit ${run.code ?? '?'}`}</Text>,
              }[run.status]

              return (
                <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
                  <Box gap={2}>
                    {status}
                    {run.status === 'confirm' && <Button key={`run-yes-${origin}`} variant="primary" label="Run" onPress={rerun} />}
                    {run.status === 'running' && <Button key={`run-stop-${origin}`} label="Stop" onPress={() => stop($, origin)} />}
                    {(run.status === 'done' || run.status === 'stopped') && <Button key={`run-again-${origin}`} label="Rerun" onPress={rerun} />}
                    {run.status === 'done' && <Button key={`run-copy-${origin}`} label="Copy" onPress={copy(run.output)} />}
                    {run.status === 'done' && <Button key={`run-claude-${origin}`} variant="primary" label="→ Claude" onPress={toClaude} />}
                    <Button plain key={`run-expand-${origin}`} label={isExpanded ? '⤡' : '⤢'} onPress={() => update($, expandMember, () => !isExpanded)} />
                    {!isExpanded && <Button plain key={`run-less-${origin}`} label="−" onPress={resize(-5)} />}
                    {!isExpanded && <Button plain key={`run-more-${origin}`} label="+" onPress={resize(5)} />}
                    <Button plain key={`run-close-${origin}`} label="✕" onPress={() => dismiss($, origin)} />
                  </Box>
                  {restView}
                  {!restView && lines.length > rows && <Text dimColor>{`… ${lines.length - rows} lines above`}</Text>}
                  {!restView && run.output !== '' && shown.map(line => <Text>{line || ' '}</Text>)}
                </Box>
              )
            }

            const boxes = await Promise.all(block.commands.map((command, j) => runBox(command, `${e.requestId}:${i}-${j}`)))
            // One shell for the whole block: a `cd` or an `export` holds for the lines after it.
            const allBox = block.commands.length > 1 ? await runBox(block.commands.join('\n'), `${e.requestId}:${i}-all`) : null

            return (
              <Box flexDirection="column" borderStyle="round" borderColor={config.colors.shell} paddingX={1}>
                <Box gap={1}>
                  <Text bold color="black" backgroundColor={config.colors.shell}> SHELL </Text>
                  {canClick && block.commands.length > 1 && (
                    <Button plain key={`cmd-all-${i}`} label="⧉ all" onPress={copy(block.commands.join('\n'))} />
                  )}
                  {canClick && config.features.run && block.commands.length > 1 && (
                    <Button plain key={`run-all-${i}`} label={needsConfirm(block.commands.join('\n')) ? '▶⚠ all' : '▶ all'} onPress={() => launch($, block.commands.join('\n'), `${e.requestId}:${i}-all`, false)} />
                  )}
                </Box>
                {block.commands.map((command, j) => {
                  const api = parseApiCall(command)
                  const actions = canClick && (
                    <Box gap={1}>
                      {config.features.run && <Button plain key={`run-${i}-${j}`} label={needsConfirm(command) ? '▶⚠' : '▶'} onPress={() => launch($, command, `${e.requestId}:${i}-${j}`, config.features.restClient)} />}
                      <Button plain key={`cmd-${i}-${j}`} label="⧉" onPress={copy(command)} />
                    </Box>
                  )
                  const origin = `${e.requestId}:${i}-${j}`
                  if (!api) {
                    return (
                      <Box flexDirection="column">
                        <Box gap={1}>
                          <Text bold color={config.colors.shell}>$</Text>
                          <Box flexShrink={1}>
                            <Text color="cyan">{command}</Text>
                          </Box>
                          {actions}
                        </Box>
                        {boxes[j]}
                      </Box>
                    )
                  }
                  return (
                    <Box flexDirection="column">
                      <Box gap={1}>
                        <Text bold color="black" backgroundColor={METHOD_COLORS[api.method] ?? 'gray'}>
                          {` ${api.method} `}
                        </Text>
                        <Text bold>{shortLabel(api.url)}</Text>
                        {actions}
                      </Box>
                      <Box paddingLeft={2}>
                        <Text dimColor>{command}</Text>
                      </Box>
                      {boxes[j]}
                    </Box>
                  )
                })}
                {allBox}
              </Box>
            )
          }

          case 'code': {
            const style = langStyle(block.lang)
            const origin = `${e.requestId}:${i}`
            const isSql = config.features.sqlConsole && /^(sql|mysql|mariadb)$/i.test(block.lang)
            const json = config.features.jsonViewer && /^json5?$/i.test(block.lang) ? parseJson(block.text) : undefined
            const treeMember = memberOf(isOpenFamily, { requestId: `${origin}:tree` })
            const isTree = json !== undefined && (await read($, treeMember))
            const sql = isSql && canClick ? await read($, sqlAtom) : null
            const sqlBox = sql?.origin === origin && (
              <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
                <Box gap={2}>
                  {sql.status === 'running' && <Text color="yellow">◌ querying…</Text>}
                  {sql.status === 'error' && <Text bold color="red">{`✘ ${sql.message}`}</Text>}
                  {sql.status === 'done' && sql.simulation && (
                    <Text bold color="black" backgroundColor="yellow">{` SIMULATION ${sql.simulation.verb} `}</Text>
                  )}
                  {sql.status === 'done' && sql.simulation && (
                    <Text bold color="yellow">{`${sql.simulation.touched} row${sql.simulation.touched > 1 ? 's' : ''} would be ${sql.simulation.verb === 'DELETE' ? 'deleted' : 'updated'} · nothing written · ${sql.ms} ms · ${sql.db}`}</Text>
                  )}
                  {sql.status === 'done' && sql.simulation && !sql.simulation.hasWhere && <Text bold color="red">⚠ no WHERE: the whole table</Text>}
                  {sql.status === 'done' && !sql.simulation && (
                    <Text bold color="green">{`✔ ${Math.min(sql.count, SQL_ROWS)}${sql.count > SQL_ROWS ? '+' : ''} row${sql.count > 1 ? 's' : ''} · ${sql.ms} ms · ${sql.db}`}</Text>
                  )}
                  {sql.status !== 'running' && <Button key={`sql-again-${origin}`} label="Rerun" onPress={() => runSql($, origin, block.text)} />}
                  {sql.status === 'done' && <Button key={`sql-copy-${origin}`} label="Copy" onPress={copy(sql.tsv)} />}
                  {sql.status !== 'running' && (
                    <Button
                      key={`sql-claude-${origin}`}
                      variant="primary"
                      label="→ Claude"
                      onPress={() => {
                        const head = sql.simulation ? `Simulation (nothing written): ${sql.simulation.touched} row(s) touched by` : 'Result of'
                        void $.prompt.fill({ text: `${head}:\n${fenced('sql', block.text)}\n${sql.status === 'done' ? sql.table : sql.message}\n`, mode: 'append' })
                      }}
                    />
                  )}
                  <Button plain key={`sql-close-${origin}`} label="✕" onPress={() => update($, sqlAtom, () => null)} />
                </Box>
                {sql.status === 'done' && sql.table !== '' && <Markdown text={sql.table} />}
              </Box>
            )

            return (
              <Box flexDirection="column" borderStyle="round" borderColor={style.color} paddingX={1}>
                <Box gap={1}>
                  <Text bold color="black" backgroundColor={style.color}>{` ${style.label} `}</Text>
                  {canClick && <Button plain key={`code-${i}`} label={/^(md|markdown)$/.test(block.lang) ? '⧉ copy' : '⧉'} onPress={copy(block.text)} />}
                  {canClick && isSql && <Button plain key={`sql-run-${i}`} label={/^\s*(delete|update)\b/im.test(block.text.replace(/^\s*--.*$/gm, '')) ? '▶ simulate' : '▶'} onPress={() => runSql($, origin, block.text)} />}
                  {canClick && json && <Button plain key={`json-tree-${i}`} label={isTree ? '{ } text' : '🌳 tree'} onPress={() => update($, treeMember, value => !value)} />}
                </Box>
                {isTree && json ? await jsonTree(json.value, origin) : <Markdown text={fenced(block.lang, block.text)} />}
                {sqlBox}
              </Box>
            )
          }

          case 'question':
            return (
              <Box gap={1}>
                <Text bold backgroundColor={config.colors.question} color="black"> ? </Text>
                <Box flexGrow={1} flexShrink={1}>
                  {prose(block.text)}
                </Box>
              </Box>
            )
        }
      }),
      )
    const drawn = await renderBlocks(blocks, '')

    const home = imageRefs.length > 0 ? ((await $.env.get('HOME')) ?? '') : ''
    const previews =
      e.surface === 'terminal'
        ? (
            await Promise.all(
              imageRefs.map(async ref => {
                const bare = ref.text.replace(/:\d+(:\d+)?$/, '')
                const path = bare.startsWith('/') ? bare : bare.startsWith('~/') ? `${home}${bare.slice(1)}` : `${cwd}/${bare}`
                const thumb = await thumbnail($, path)
                if (!thumb) return null
                const { Image } = $.ui.resolve(e)
                const cells = imageCells(thumb.width, thumb.height, 28, 12)

                return (
                  <Box key={`thumb-${path}`} flexDirection="column">
                    <Image source={{ file: thumb.png, format: 'png' }} columns={cells.columns} rows={cells.rows} alt={`preview of ${bare}`} />
                    <Box gap={1}>
                      <Text dimColor>{`${bare.split('/').pop()} · ${thumb.width}×${thumb.height}`}</Text>
                      {canClick && <Button plain key={`thumb-open-${path}`} label="Open" onPress={() => void $.process.run(['open', path])} />}
                    </Box>
                  </Box>
                )
              }),
            )
          ).filter(Boolean)
        : []

    const body = (
      <Box flexDirection="column" gap={1} flexGrow={1} flexShrink={1}>
        {drawn}
        {previews.length > 0 && (
          <Box flexWrap="wrap" columnGap={3}>
            {previews}
          </Box>
        )}
        {swatches.length > 0 && (
          <Box flexWrap="wrap" columnGap={2}>
            {swatches.map(hex => (
              <Box key={`swatch-${hex}`} gap={1}>
                <Text color={hex}>██</Text>
                <Text dimColor>{hex}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )

    // Our tree replaces the engine's row, bullet included: draw it back on the terminal.
    if (e.surface === 'terminal' && e.props.isFirstOfReply) {
      return (
        <Box>
          <Text>⏺ </Text>
          {body}
        </Box>
      )
    }

    return body
  })

  on('tool.call', async ($, e, next) => {
    const { toolHeaders, errorLens, stackLinks, problems } = config.features
    if (!(toolHeaders || errorLens || stackLinks || problems)) return next(e)
    const startedAt = await $.clock.now()
    const id = e.tool_use_id
    const result = await next(e)
    if (id && result.isError) await update($, memberOf(failureFamily, { requestId: id }), () => result.text ?? null)
    const file = (e.tool === 'Edit' || e.tool === 'Write') && !result.isError ? (e as { file_path?: unknown }).file_path : undefined
    if (id && config.features.problems && typeof file === 'string') void lintFile($, id, file)
    const ms = (await $.clock.now()) - startedAt
    await update($, memberOf(durationFamily, { requestId: id }), () => ms)

    return result
  })

  // The engine folds shell runs into one count line ("Ran 3 shell commands"), which would hide
  // a failed call's badge, error line and stack links: unfold such groups.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { toolHeaders, errorLens, stackLinks } = config.features
    const hasFailure = e.props.calls.some(call => call.isErrored) && (toolHeaders || errorLens || stackLinks)

    return hasFailure && !isOff ? next({ ...e, props: { ...e.props, isExpanded: true } }) : next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const isDrawable = e.surface === 'terminal' || e.surface === 'desktop'
    const problems = config.features.problems ? await read($, memberOf(problemsFamily, e)) : null
    const look = describeTool(e.props.tool, e.props.input, cwd)
    const hasFailureLines = e.props.isErrored && (config.features.errorLens || config.features.stackLinks)
    const isShown = config.features.toolHeaders || problems !== null || hasFailureLines
    if (isOff || !isDrawable || !look || !isShown) return next(e)
    // Another plugin beneath this one drew on the row (live job steps, say): its drawing stands, as the
    // row this hook draws would hide it. Mods nest in an order no plugin picks.
    const below = await next(e)
    // The engine's own row, unless a plugin beneath answered alone; anything between that changed it counts too.
    const engine = engineLink(next.trace)
    if (!engine || !isSameTree(below, engine.returned)) return below
    const { Box, Text, Button } = $.ui.resolve(e)

    const ms = await read($, memberOf(durationFamily, e))
    const failure = e.props.isErrored ? await read($, memberOf(failureFamily, e)) : null
    const lens = failure && config.features.errorLens ? errorLine(failure) : undefined
    const frames = failure && config.features.stackLinks ? findFrames(failure) : []
    const canClick = e.surface === 'desktop' || e.viewport?.isFullscreen === true
    const [glyph, color] = e.props.isRunning
      ? ['◌', 'yellow']
      : e.props.isInterrupted
        ? ['■', 'gray']
        : e.props.isErrored
          ? ['✘', 'red']
          : ['✔', 'green']

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold color={color}>{glyph}</Text>
          <Text bold color={look.fg} backgroundColor={look.color}>{` ${look.icon} ${look.label} `}</Text>
          <Box flexShrink={1}>
            <Text color={look.color === 'gray' ? undefined : look.color} wrap="truncate-end">{look.detail}</Text>
          </Box>
          {ms !== null && !e.props.isRunning && <Text dimColor>{ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}</Text>}
        </Box>
        {problems && problems.lines.length === 0 && (
          <Box paddingLeft={2}>
            <Text color="green" dimColor>{`✔ ${problems.tool}`}</Text>
          </Box>
        )}
        {problems && problems.lines.length > 0 && (
          <Box flexDirection="column" paddingLeft={2}>
            <Box gap={1}>
              <Text bold color="black" backgroundColor="red">{` ✘ ${problems.lines.length} `}</Text>
              <Text color="red">{problems.tool}</Text>
              {canClick && (
                <Button plain key={`problems-claude-${e.requestId}`} label="→ Claude" onPress={() => $.prompt.fill({ text: `${problems.tool} reports:\n${fenced('', problems.lines.join('\n'))}\n`, mode: 'append' })} />
              )}
            </Box>
            {problems.lines.slice(0, 8).map(line => (
              <Text color="red" wrap="truncate-end">{line}</Text>
            ))}
            {problems.lines.length > 8 && <Text dimColor>{`… ${problems.lines.length - 8} more`}</Text>}
            {canClick && findFrames(problems.lines.join('\n')).length > 0 && (
              <Box flexWrap="wrap" columnGap={2}>
                {findFrames(problems.lines.join('\n')).map((frame, n) => (
                  <Button plain key={`problems-frame-${e.requestId}-${n}`} label={`↗ ${frame.path.split('/').pop()}:${frame.line}`} onPress={() => openInEditor($, frame, cwd, config.editor)} />
                ))}
              </Box>
            )}
          </Box>
        )}
        {lens && (
          <Box paddingLeft={2}>
            <Text color="red" wrap="truncate-end">{`▸ ${lens}`}</Text>
          </Box>
        )}
        {frames.length > 0 && (
          <Box paddingLeft={2} flexWrap="wrap" columnGap={2}>
            {frames.map((frame, n) =>
              canClick ? (
                <Button plain key={`frame-${e.requestId}-${n}`} label={`↗ ${frame.path}:${frame.line}`} onPress={() => openInEditor($, frame, cwd, config.editor)} />
              ) : (
                <Text key={`frame-${n}`} color={config.colors.path}>{`↗ ${frame.path}:${frame.line}`}</Text>
              ),
            )}
          </Box>
        )}
      </Box>
    )
  })
}
