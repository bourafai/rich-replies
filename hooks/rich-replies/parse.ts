import type { Check, CheckState } from '../../types'
export type Block =
  | { type: 'markdown'; text: string }
  | { type: 'tldr'; text: string }
  | { type: 'details'; title: string; text: string }
  | { type: 'command'; commands: string[]; raw: string }
  | { type: 'code'; lang: string; text: string; raw: string }
  | { type: 'question'; text: string }

// A file path a reply cites, `in/backticks.ts` or a markdown link target.
export type Ref = { text: string }

// Brand colors, so a block's language reads at a glance; truecolor terminals show them exact.
export const LANGS: Record<string, { label: string; color: string }> = {
  php: { label: 'PHP', color: '#8892BF' },
  js: { label: 'JS', color: '#F7DF1E' },
  javascript: { label: 'JS', color: '#F7DF1E' },
  jsx: { label: 'JSX', color: '#61DAFB' },
  ts: { label: 'TS', color: '#3178C6' },
  typescript: { label: 'TS', color: '#3178C6' },
  tsx: { label: 'TSX', color: '#3178C6' },
  py: { label: 'PY', color: '#3776AB' },
  python: { label: 'PY', color: '#3776AB' },
  json: { label: 'JSON', color: '#CBCB41' },
  sql: { label: 'SQL', color: '#E38C00' },
  css: { label: 'CSS', color: '#663399' },
  scss: { label: 'SCSS', color: '#CC6699' },
  html: { label: 'HTML', color: '#E34F26' },
  twig: { label: 'TWIG', color: '#8CBC4E' },
  yaml: { label: 'YAML', color: '#CB171E' },
  yml: { label: 'YAML', color: '#CB171E' },
  diff: { label: 'DIFF', color: '#41B883' },
  md: { label: 'MD', color: '#9E9E9E' },
  markdown: { label: 'MD', color: '#9E9E9E' },
  text: { label: 'TEXT', color: '#9E9E9E' },
}

export function langStyle(lang: string): { label: string; color: string } {
  return LANGS[lang] ?? { label: (lang || 'text').toUpperCase(), color: '#9E9E9E' }
}

const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'console'])

// The line closing the fence opened at `open`, or -1. A fence with a language inside it
// (```bash in an md fence) nests until its own bare closer, so the outer block stays whole.
function closingFence(lines: string[], open: number, marker: string): number {
  const char = marker[0] === '~' ? '~' : '`'
  const closer = new RegExp(`^\\s*${char}{${marker.length},}\\s*$`)
  const opener = new RegExp(`^\\s*${char}{3,}\\s*[\\w-]+`)
  let depth = 0
  for (let j = open + 1; j < lines.length; j++) {
    const line = lines[j] ?? ''
    if (opener.test(line)) depth++
    else if (closer.test(line)) {
      if (depth === 0) return j
      depth--
    }
  }

  return -1
}

export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = []
  const lines = src.split('\n')
  let prose: string[] = []

  const flush = () => {
    let pending: string[] = []
    const pushPending = () => {
      const text = pending.join('\n\n').trim()
      if (text) blocks.push({ type: 'markdown', text })
      pending = []
    }
    for (const paragraph of prose.join('\n').split(/\n\s*\n/)) {
      if (isQuestion(paragraph)) {
        pushPending()
        blocks.push({ type: 'question', text: paragraph.trim() })
      } else {
        pending.push(paragraph)
      }
    }
    pushPending()
    prose = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)/)
    if (fence) {
      const marker = fence[1] ?? '```'
      const close = closingFence(lines, i, marker)
      // Unclosed fence (reply still streaming): leave it to the engine's markdown.
      if (close === -1) {
        prose.push(line)
        continue
      }
      const raw = lines.slice(i, close + 1).join('\n')
      if (SHELL_LANGS.has((fence[2] ?? '').toLowerCase())) {
        flush()
        const commands = lines
          .slice(i + 1, close)
          .map(l => l.replace(/^\s*\$\s+/, ''))
          .join('\n')
          // A trailing backslash continues the command on the next line (multi-line curl).
          .replace(/[ \t]*\\\n\s*/g, ' ')
          .split('\n')
          .filter(l => l.trim() && !l.trim().startsWith('#'))
        blocks.push({ type: 'command', commands, raw })
      } else {
        flush()
        blocks.push({ type: 'code', lang: (fence[2] ?? '').toLowerCase(), text: lines.slice(i + 1, close).join('\n'), raw })
      }
      i = close
      continue
    }

    const section = line.match(/^:::\s*(tldr|details)\b\s*(.*)$/i)
    if (section) {
      const close = lines.findIndex((l, j) => j > i && l.trim() === ':::')
      if (close === -1) {
        prose.push(line)
        continue
      }
      flush()
      const text = lines.slice(i + 1, close).join('\n').trim()
      if ((section[1] ?? '').toLowerCase() === 'tldr') {
        blocks.push({ type: 'tldr', text })
      } else {
        blocks.push({ type: 'details', title: (section[2] ?? '').trim() || 'Details', text })
      }
      i = close
      continue
    }

    prose.push(line)
  }
  flush()

  return blocks
}

function isQuestion(paragraph: string): boolean {
  const last = paragraph.trim().split('\n').pop()?.trim() ?? ''

  return !last.startsWith('|') && /\?\s*[*_]*$/.test(last)
}

export function findRefs(src: string): Ref[] {
  const text = src.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, '')
  const paths = /`((?:~|\.{1,2})?\/?[\w@.-]+(?:\/[\w@.-]+)+\.[a-z0-9]+(?::\d+(?::\d+)?)?)`|\]\(((?!https?:)[^)\s]+\.[a-z0-9]+(?::\d+)?)\)/gi
  const found = [...text.matchAll(paths)].map(match => match[1] ?? match[2] ?? '').filter(Boolean)

  return [...new Set(found)].map(path => ({ text: path }))
}

function isPullRequest(raw: string): boolean {
  try {
    return /\/pull\/\d+|\/merge_requests\/\d+/.test(new URL(raw).pathname)
  } catch {
    return false
  }
}

// What an inline link or the REST client shows instead of the raw URL: `repo #367` for a PR, else host and path.
export function shortLabel(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  const host = url.hostname.replace(/^www\./, '')
  if (isPullRequest(raw)) {
    const [, , repo, , number] = url.pathname.split('/')
    const mr = url.pathname.match(/\/merge_requests\/(\d+)/)?.[1]

    return `${repo ?? host} #${mr ?? number ?? ''}`
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  const label = `${host}${url.port ? `:${url.port}` : ''}${path}`

  return label.length > 40 ? `${label.slice(0, 39)}…` : label
}

// Code and reference definitions, held out of the prose rewrites: fences line by line (a longer
// fence holds shorter ones; an unclosed one runs to the end, as while a reply streams), then code
// spans closed by a backtick run of the same length. Each becomes a placeholder until restore.
const HELD = /\uE000(\d+)\uE001/g

export function holdCode(markdown: string): { text: string; restore: (text: string) => string } {
  const held: string[] = []
  const hold = (code: string) => `\uE000${held.push(code) - 1}\uE001`
  let text = ''
  let fence: { code: string; close: RegExp } | null = null
  for (const line of markdown.split(/(?<=\n)/)) {
    if (fence) {
      fence.code += line
      if (fence.close.test(line)) {
        text += hold(fence.code)
        fence = null
      }
      continue
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)/)
    const marker = open?.[1] ?? ''
    if (open && !(marker.startsWith('`') && (open[2] ?? '').includes('`'))) {
      fence = { code: line, close: new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*\\n?$`) }
      continue
    }
    text += line
  }
  if (fence) text += hold(fence.code)
  text = text.replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*/gm, hold).replace(/(?<!`)(`+)(?!`)((?:(?!\n\n)[\s\S])*?[^`])\1(?!`)/g, hold)

  return { text, restore: rewritten => rewritten.replace(HELD, (_whole, n: string) => held[Number(n)] ?? '') }
}

// In held prose: a markdown link or image (a title, and one level of [brackets] in the label, allowed),
// an autolink, or a bare URL. Groups 1 and 2 hold the first two's URL; a bare URL is the whole match,
// never one inside link syntax.
export const LINK =
  /!?\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)|<(https?:\/\/[^>\s]+)>|(?<![(<[\w/="'])https?:\/\/(?:\[[\da-f:.]+\][^\s<>()`'"\]\uE000\uE001]*|[^\s<>()`'"[\]\uE000\uE001]+)/gi

// Bare URLs in prose become `[label](url)`, a PR's led by ⎇; code, images and existing links stay as written.
export function inlineLinks(markdown: string): string {
  const { text, restore } = holdCode(markdown)

  return restore(
    text.replace(LINK, (whole: string, inLink?: string, inAngle?: string) => {
      if (inLink || inAngle) return whole
      const url = whole.replace(/[.,;:!?*_]+$/, '')

      return `[${isPullRequest(url) ? '⎇ ' : ''}${shortLabel(url)}](${url})${whole.slice(url.length)}`
    }),
  )
}

export type ApiCall = { method: string; url: string }

// curl, wget, HTTPie and xh calls, shown with their method instead of as plain CLI.
export function parseApiCall(command: string): ApiCall | undefined {
  const tool = command.trim().split(/\s+/)[0] ?? ''
  if (!['curl', 'wget', 'http', 'https', 'xh'].includes(tool)) return undefined
  const url = command.match(/https?:\/\/[^\s'"]+/)?.[0]
  if (!url) return undefined
  const explicit = command.match(/(?:-X|--request|--method)[\s=]*['"]?([A-Za-z]+)/)?.[1]
  const httpie = command.match(/^\s*(?:https?|xh)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i)?.[1]
  const hasBody = /\s(?:-d|--data[\w-]*|-F|--form|--json|--post-data)\b/.test(command)
  const isUpload = /\s(?:-T|--upload-file)\b/.test(command)

  return { method: (explicit ?? httpie ?? (isUpload ? 'PUT' : hasBody ? 'POST' : 'GET')).toUpperCase(), url }
}

// ponytail: pattern list, not a parser; a miss still runs only on the person's own click
export function isRisky(command: string): boolean {
  return /\brm\s+(-\S+\s+)*(-\w*[rf]|--(recursive|force)\b)|\bgit(\s+-[cC]\s+\S+|\s+--?[\w-]+(=\S+)?)*\s+(push|reset\s+--hard|clean\s+-\w*f)|\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\s(-T|--upload-file)\b|\b(drop|truncate)\s+(table|database)|\bdelete\s+from\b|\bupdate\s+\w+\s+set\b|(-X|--request|--method)[\s=]*['"]?(DELETE|PUT|PATCH|POST)\b|^\s*(https?|xh)\s+(DELETE|PUT|PATCH|POST)\b|\bdocker\s+(rm|rmi|volume\s+rm|system\s+prune)|\bsudo\b|\bkill\b/i.test(
    command,
  )
}

// Terminal output as plain text: no escape sequences, carriage-return overwrites kept last.
export function cleanOutput(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[^\n]*\r/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

export type ToolLook = { icon: string; label: string; color: string; fg: string; detail: string }

const MCP_PALETTE = ['#60A5FA', '#C084FC', '#22D3EE', '#FACC15', '#4ADE80', '#F472B6']

const field = (input: unknown, key: string): string => {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined

  return typeof value === 'string' ? value : ''
}

const firstLine = (text: string) => {
  const [first = '', ...rest] = text.trim().split('\n')

  return rest.length > 0 ? `${first} …` : first
}

// The call's first string argument, quoted: enough to tell two calls of one tool apart.
const firstArg = (input: unknown): string => {
  const value = input && typeof input === 'object' ? Object.values(input).find(v => typeof v === 'string') : undefined
  if (typeof value !== 'string' || !value) return ''
  const line = firstLine(value)

  return `"${line.length > 60 ? `${line.slice(0, 59)}…` : line}"`
}

const relative = (path: string, cwd: string) =>
  cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path.replace(/^\/Users\/[^/]+/, '~')

// The header a tool row draws: Read/Grep/Glob stay the engine's, folded into its count lines.
export function describeTool(tool: string, input: unknown, cwd = ''): ToolLook | undefined {
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/)
  if (mcp) {
    const server = (mcp[1] ?? '').replace(/^(claude_ai_|plugin_[^_]+_)/, '')
    const detail = `${mcp[2] ?? ''} ${firstArg(input)}`.trim()
    const hash = [...server].reduce((sum, char) => sum + char.charCodeAt(0), 0)

    return { icon: '⬡', label: server.toUpperCase(), color: MCP_PALETTE[hash % MCP_PALETTE.length] ?? 'blue', fg: 'black', detail }
  }

  switch (tool) {
    case 'Bash': {
      return { icon: '$', label: 'SHELL', color: 'green', fg: 'black', detail: firstLine(field(input, 'command')) }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { icon: '✎', label: 'EDIT', color: 'yellow', fg: 'black', detail: relative(field(input, 'file_path') || field(input, 'notebook_path'), cwd) }
    case 'Write':
      return { icon: '✚', label: 'WRITE', color: 'yellow', fg: 'black', detail: relative(field(input, 'file_path'), cwd) }
    case 'WebFetch':
      return { icon: '↗', label: 'FETCH', color: 'blue', fg: 'white', detail: field(input, 'url') }
    case 'WebSearch':
      return { icon: '⌕', label: 'SEARCH', color: 'blue', fg: 'white', detail: field(input, 'query') }
    case 'Agent':
    case 'Task':
      return { icon: '◇', label: 'AGENT', color: 'magenta', fg: 'white', detail: field(input, 'description') }
    case 'Skill':
      return { icon: '✦', label: 'SKILL', color: 'cyan', fg: 'black', detail: field(input, 'skill') }
  }

  return undefined
}

// The engine's own answer in a next.trace: the deepest link that answered, when it is the engine
// (tier core). The test kit's own hooks play the engine as plugin `test`, tier builtin. A trace that
// ends at any other link means that plugin, bundled or installed, answered without calling next: its
// drawing is final, and there is no engine row to compare with.
export function engineLink<T extends { plugin: string; tier: string; returned?: unknown }>(trace: readonly T[]): T | undefined {
  const last = trace.findLast(link => link.returned !== undefined)
  const isEngine = last?.tier === 'core' || (last?.tier === 'builtin' && last.plugin === 'test')

  return isEngine ? last : undefined
}

// Two drawings alike whatever their keys' order; callbacks (onPress) count as alike, as data cannot compare them.
export function isSameTree(a: unknown, b: unknown): boolean {
  if (typeof a === 'function' && typeof b === 'function') return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a).filter(key => (a as Record<string, unknown>)[key] !== undefined)
  const keysB = Object.keys(b).filter(key => (b as Record<string, unknown>)[key] !== undefined)

  return keysA.length === keysB.length && keysA.every(key => isSameTree((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

// A bar in cells: █ done, ░ left.
export const progressBar = (percent: number, width = 20) => {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) * width) / 100)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}


// Everything ships off: each user turns on what they want in ~/.claude/rich-replies.jsonc.
export const FEATURES = {
  tldr: false,
  details: false,
  questions: false,
  codeBlocks: false,
  shellBlocks: false,
  run: false,
  links: false,
  toolHeaders: false,
  colorSwatches: false,
  errorLens: false,
  stackLinks: false,
  problems: false,
  sqlConsole: false,
  restClient: false,
  jsonViewer: false,
  imagePreview: false,
  changesCommand: false,
  prCommand: false,
  execCommand: false,
}

// Tailwind 400 shades: bright enough on a dark background, black text stays readable on them as badges.
export const PALETTE = {
  sky: '#38BDF8',
  violet: '#A78BFA',
  amber: '#FBBF24',
  emerald: '#34D399',
  teal: '#2DD4BF',
  orange: '#FB923C',
  rose: '#FB7185',
  fuchsia: '#E879F9',
  pink: '#FF4785',
  slate: '#94A3B8',
}

export const COLORS: Record<'tldr' | 'details' | 'question' | 'shell' | 'progress' | 'pr' | 'path', string> = {
  tldr: PALETTE.sky,
  details: PALETTE.violet,
  question: PALETTE.amber,
  shell: PALETTE.emerald,
  progress: PALETTE.teal,
  pr: PALETTE.fuchsia,
  path: PALETTE.teal,
}

export type Config = { features: typeof FEATURES; colors: typeof COLORS; editor: string }
export const DEFAULT_CONFIG: Config = { features: FEATURES, colors: COLORS, editor: 'cursor' }

const COLOR = /^(#[0-9a-f]{6}|black|red|green|yellow|blue|magenta|cyan|white|gray|grey)$/i
const HEX = /^#[0-9a-f]{6}$/i

// `//` comments, outside strings: the file stays a readable JSONC.
const stripComments = (text: string) =>
  text
    .split('\n')
    .map(line => {
      for (let at = line.indexOf('//'); at !== -1; at = line.indexOf('//', at + 2)) {
        if ((line.slice(0, at).match(/"/g) ?? []).length % 2 === 0) return line.slice(0, at)
      }

      return line
    })
    .join('\n')

// The config file's JSONC as a value: `//` comments and trailing commas allowed; throws on bad JSON.
export const parseJsonc = (text: string): unknown => JSON.parse(stripComments(text).replace(/,(\s*[}\]])/g, '$1'))

// Keys of removed features: an old file still holds them, and that is no mistake worth a toast.
const RETIRED = ['zen', 'zenCommand', 'snapCommand']
// Link colors by environment, gone with the environments: an old config keeps them without a toast.
const RETIRED_COLORS = ['local', 'staging', 'prod', 'storybook', 'external']

// The user's file over the defaults, key by key: an unknown key or a bad value is reported and skipped.
export function readConfig(text: string): { config: Config; errors: string[] } {
  const errors: string[] = []
  let raw: unknown
  try {
    raw = parseJsonc(text)
  } catch (error) {
    return { config: DEFAULT_CONFIG, errors: [`JSON: ${(error as Error).message}`] }
  }
  const section = (name: string) => {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[name] : undefined

    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  }
  const features = { ...FEATURES }
  for (const [key, value] of Object.entries(section('features'))) {
    if (RETIRED.includes(key)) continue
    if (!(key in features)) errors.push(`features.${key}: unknown`)
    else if (typeof value !== 'boolean') errors.push(`features.${key}: true or false`)
    else features[key as keyof typeof FEATURES] = value
  }
  // The palette names colors once; `colors` then refers to them by name.
  const palette: Record<string, string> = {}
  for (const [name, value] of Object.entries(section('palette'))) {
    if (typeof value === 'string' && HEX.test(value)) palette[name] = value
    else errors.push(`palette.${name}: #rrggbb`)
  }
  const colors = { ...COLORS }
  for (const [key, value] of Object.entries(section('colors'))) {
    const color = typeof value === 'string' ? (palette[value] ?? value) : undefined
    if (RETIRED_COLORS.includes(key)) continue
    if (!(key in colors)) errors.push(`colors.${key}: unknown`)
    else if (color === undefined || !COLOR.test(color)) errors.push(`colors.${key}: a palette name, a color name or #rrggbb`)
    else colors[key as keyof typeof COLORS] = color
  }

  const editor = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).editor : undefined
  const isEditor = typeof editor === 'string' && /^[\w.-]+$/.test(editor)
  if (editor !== undefined && !isEditor) errors.push('editor: a command name (cursor, code)')

  return { config: { features, colors, editor: isEditor ? editor : DEFAULT_CONFIG.editor }, errors }
}

// A switched-off block draws as plain markdown, its markers gone.
export function applyFeatures(blocks: Block[], features: typeof FEATURES): Block[] {
  return blocks.map(block => {
    if (block.type === 'tldr' && !features.tldr) return { type: 'markdown', text: block.text }
    if (block.type === 'details' && !features.details) return { type: 'markdown', text: `**${block.title}**\n\n${block.text}` }
    if (block.type === 'question' && !features.questions) return { type: 'markdown', text: block.text }
    if ((block.type === 'code' && !features.codeBlocks) || (block.type === 'command' && !features.shellBlocks)) return { type: 'markdown', text: block.raw }

    return block
  })
}

const ERROR_WORDS = /\b(error|fatal|exception|failed|failure|denied|not found|no such|cannot|refused|traceback)\b|✗|✘/i

// The line that says what went wrong: the first naming an error, else the last one printed.
export function errorLine(text: string): string | undefined {
  const lines = cleanOutput(text)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const line = lines.find(one => ERROR_WORDS.test(one)) ?? lines.at(-1)

  return line && (line.length > 160 ? `${line.slice(0, 159)}…` : line)
}

export type Frame = { path: string; line: number }
const CODE_FILE = String.raw`((?:[\w.@+-]*\/)*[\w.@+-]+\.(?:php|phtml|twig|js|jsx|mjs|cjs|ts|tsx|vue|py|rb|go|rs|java|sh|sql|json|ya?ml|css|scss))`
const FRAME_PATTERNS = [
  /File "([^"]+)", line (\d+)/g,
  new RegExp(`${CODE_FILE} on line (\\d+)`, 'g'),
  new RegExp(`${CODE_FILE}\\((\\d+)(?:,\\d+)?\\)`, 'g'),
  new RegExp(`${CODE_FILE}:(\\d+)`, 'g'),
]

// File:line places in a stack trace, compiler or grep output: PHP, Node, Python and tsc spellings.
export function findFrames(text: string, max = 6): Frame[] {
  const clean = cleanOutput(text)
  const seen = new Map<string, Frame>()
  for (const pattern of FRAME_PATTERNS) {
    for (const match of clean.matchAll(pattern)) {
      const frame = { path: match[1] ?? '', line: Number(match[2]) }
      const key = `${frame.path}:${frame.line}`
      if (frame.path && !seen.has(key)) seen.set(key, frame)
    }
  }

  return [...seen.values()].slice(0, max)
}

const hex2 = (n: number) => Math.min(255, n).toString(16).padStart(2, '0')

// A 3-digit #RGB needs a letter: "#367" is a PR number.
const COLOR_IN_TEXT = /(?<![\w&/])#([0-9a-f]{6}|[0-9a-f]{3})(?![\w-])|rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi

// The #RRGGBB a COLOR_IN_TEXT match names, or undefined for a digit-only #RGB.
function colorOf(value?: string, r?: string, g?: string, b?: string): string | undefined {
  if (value === undefined) return `#${hex2(Number(r))}${hex2(Number(g))}${hex2(Number(b))}`.toUpperCase()
  if (value.length === 3 && !/[a-f]/i.test(value)) return undefined

  return `#${value.length === 3 ? [...value].map(c => c + c).join('') : value}`.toUpperCase()
}

// Colors written in the text, as #RRGGBB.
export function findColors(text: string, max = 16): string[] {
  const found = [...text.matchAll(COLOR_IN_TEXT)].map(m => colorOf(m[1], m[2], m[3], m[4])).filter((hex): hex is string => hex !== undefined)

  return [...new Set(found)].slice(0, max)
}

export type SwatchPart = { text: string; hex?: string }

// Block Markdown, whose meaning can reach past its paragraph: heading (# or underlined), list, quote, table,
// fence, indented code, reference link definition.
export function hasMarkdownStructure(paragraph: string): boolean {
  return /^\s*(#{1,6}\s|[-+*]\s|\d+[.)]\s|>|\|)|^\s*(=+|-{2,})\s*$|^( {4}|\t)|^\s*\[[^\]]+\]:|```|~~~/m.test(paragraph)
}

// Prose the Markdown component would draw exactly as written: no block structure, and no emphasis, code, link,
// html or entity. An underscore inside a word (snake_case) is no emphasis.
export function isPlainProse(paragraph: string): boolean {
  return !hasMarkdownStructure(paragraph) && !/[*`[\]<>~|\\]|(?<!\w)_|_(?!\w)|&\w+;|https?:\/\//.test(paragraph)
}

// A paragraph naming colors, as text runs with a swatch before each color, so the ██ sits in its line.
// The Markdown component refuses color codes, hence runs; a paragraph with other markdown (or no color) gives null.
export function splitSwatches(paragraph: string): SwatchPart[] | null {
  if (!isPlainProse(paragraph)) return null
  const parts: SwatchPart[] = []
  let from = 0
  for (const match of paragraph.matchAll(COLOR_IN_TEXT)) {
    const hex = colorOf(match[1], match[2], match[3], match[4])
    if (!hex) continue
    parts.push({ text: paragraph.slice(from, match.index) }, { text: '', hex })
    from = match.index
  }
  if (parts.length === 0) return null

  return [...parts, { text: paragraph.slice(from) }]
}

export type DiffFile = { file: string; header: string; hunks: string[] }

// `git diff` split per file and hunk; a hunk's patch is its file header plus the hunk.
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  for (const section of diff.split(/^(?=diff --git )/m)) {
    if (!section.startsWith('diff --git ')) continue
    const [header = '', ...rest] = section.split(/^(?=@@ )/m)
    const file = header.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? header.match(/^diff --git a\/(.+?) b\//)?.[1] ?? '?'
    files.push({ file, header, hunks: rest.map(hunk => `${hunk.replace(/\n+$/, '')}\n`) })
  }

  return files
}


// `gh pr view --json statusCheckRollup`: GitHub Actions runs and commit statuses, one shape.
export function prChecks(rollup: unknown): Check[] {
  if (!Array.isArray(rollup)) return []

  return rollup.map((raw: Record<string, unknown>) => {
    const name = String(raw.name ?? raw.context ?? '?')
    const url = String(raw.detailsUrl ?? raw.targetUrl ?? '')
    const verdict = String(raw.conclusion || raw.state || '')
    const isDone = raw.__typename === 'StatusContext' ? verdict !== 'PENDING' && verdict !== 'EXPECTED' : raw.status === 'COMPLETED'
    const state: CheckState = !isDone
      ? 'pending'
      : ['SUCCESS'].includes(verdict)
        ? 'ok'
        : ['SKIPPED', 'NEUTRAL', 'STALE'].includes(verdict)
          ? 'skip'
          : 'fail'

    return { name, state, url }
  })
}

// Cells for a picture of width x height px: two px rows per cell row, aspect kept under the row cap.
export function imageCells(width: number, height: number, maxColumns: number, maxRows = 200) {
  const columns = Math.max(10, Math.min(maxColumns, 255))
  const rows = Math.max(1, Math.round((columns * height) / width / 2))
  if (rows <= maxRows) return { columns, rows }

  return { columns: Math.max(4, Math.round((maxRows * 2 * width) / height)), rows: maxRows }
}

// --- Problems: a linter's lines after an edit ---

// The lines of a linter's output that name a place or a problem, without its summary chatter.
export function lintLines(output: string, max = 20): string[] {
  return cleanOutput(output)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^(\d+ problems?|✖ \d+ problems?|No syntax errors detected|Errors parsing|\(\d+ errors?, \d+ warnings?\))/i.test(line))
    // php -l prints each error twice, once prefixed "PHP " (spacing differs): one problem, one line.
    .filter((line, _n, lines) => {
      const squash = (text: string) => text.replace(/\s+/g, ' ')
      return !(line.startsWith('PHP ') && lines.some(other => squash(other) === squash(line.slice(4))))
    })
    .slice(0, max)
}

// --- SQL console ---

// `simulates`: the DELETE or UPDATE as written, run as the SELECT of the rows it would touch.
export type SqlTarget = { db: string; query: string; simulates?: { verb: 'DELETE' | 'UPDATE'; statement: string; hasWhere: boolean } }

const blank = (text: string) => text.replace(/[^\n]/g, ' ')

// Each position's parenthesis depth, strings and comments already blanked out of `mask`.
function depths(mask: string): number[] {
  let depth = 0
  return [...mask].map(char => (char === '(' ? depth++ : char === ')' ? --depth : depth))
}

// First match of `pattern` outside any parenthesis, at or after `from`; -1 when none.
function topLevel(mask: string, pattern: RegExp, from = 0): { at: number; end: number } {
  const level = depths(mask)
  for (const match of mask.matchAll(new RegExp(pattern.source, 'gi'))) {
    if (match.index >= from && level[match.index] === 0) return { at: match.index, end: match.index + match[0].length }
  }
  return { at: -1, end: -1 }
}

// Splits on the commas outside parentheses; `mask` and `text` have the same length.
function splitTopLevel(text: string, mask: string): string[] {
  const level = depths(mask)
  const parts: string[] = []
  let start = 0
  for (let at = 0; at < mask.length; at++) {
    if (mask[at] === ',' && level[at] === 0) {
      parts.push(text.slice(start, at))
      start = at + 1
    }
  }

  return [...parts, text.slice(start)].map(part => part.trim())
}

// A DELETE or UPDATE as the SELECT of the rows it would touch, with their count; never the write itself.
// ponytail: single-table targets and plain SET lists; a multi-table DELETE or a RETURNING is refused.
function simulation(query: string, mask: string): { query: string; verb: 'DELETE' | 'UPDATE'; hasWhere: boolean } | string {
  const hasWhere = topLevel(mask, /\bwhere\b/).at !== -1
  const wrap = (inner: string) => `SELECT COUNT(*) OVER () AS \`rows touched\`, s.* FROM (${inner}) AS s`
  if (/\breturning\b/i.test(mask)) return 'Simulation: no RETURNING'
  const del = mask.match(/^\s*delete\s+(?:(?:low_priority|quick|ignore)\s+)*/i)
  if (del) {
    const from = topLevel(mask, /\bfrom\b/, del[0].length)
    if (from.at === -1) return 'Simulation: DELETE without FROM'
    const target = query.slice(del[0].length, from.at).trim()
    if (target.includes(',') || /\busing\b/i.test(mask)) return 'Simulation: one table at a time'

    return { query: wrap(`SELECT ${target ? `${target}.*` : '*'} FROM ${query.slice(from.end).trim()}`), verb: 'DELETE', hasWhere }
  }
  const upd = mask.match(/^\s*update\s+(?:(?:low_priority|ignore)\s+)*/i)
  if (!upd) return 'Simulation: only DELETE and UPDATE can be simulated'
  const set = topLevel(mask, /\bset\b/, upd[0].length)
  if (set.at === -1) return 'Simulation: UPDATE without SET'
  const tail = topLevel(mask, /\b(where|order\s+by|limit)\b/, set.end)
  const end = tail.at === -1 ? query.length : tail.at
  const columns = splitTopLevel(query.slice(set.end, end), mask.slice(set.end, end)).map(assignment => {
    const eq = assignment.indexOf('=')
    const column = assignment.slice(0, eq).trim()
    const name = column.replace(/`/g, '')

    return eq === -1 ? '' : `${column} AS \`${name} before\`, (${assignment.slice(eq + 1).trim()}) AS \`${name} after\``
  })
  if (columns.includes('')) return 'Simulation: expected SET column = value'

  return { query: wrap(`SELECT ${columns.join(', ')} FROM ${query.slice(upd[0].length, set.at).trim()} ${query.slice(end).trim()}`.trim()), verb: 'UPDATE', hasWhere }
}

// The SQL as the client reads it, left to right: a quote opens a string (a backslash escapes the next character,
// runSql turns NO_BACKSLASH_ESCAPES off so the server agrees), and outside strings `-- `, `#` and `/* */` open comments.
// `mask` blanks string contents and comments, `clean` blanks comments only; both keep every position.
// One pass matters: a regex that blanks strings first reads the apostrophe of `-- it's` as a string and hides a `;` after it.
function scanSql(sql: string): { mask: string; clean: string; isExecutable: boolean } {
  let mask = ''
  let clean = ''
  let isExecutable = false
  let i = 0
  while (i < sql.length) {
    const c = sql[i] ?? ''
    const next = sql[i + 1] ?? ''
    let end = i + 1
    if (c === "'" || c === '"' || c === '`') {
      while (end < sql.length && sql[end] !== c) end += c !== '`' && sql[end] === '\\' ? 2 : 1
      end = Math.min(end + 1, sql.length)
      const literal = sql.slice(i, end)
      mask += literal.length > 1 ? c + blank(literal.slice(1, -1)) + (literal.at(-1) === c ? c : ' ') : c
      clean += literal
    } else if (c === '#' || (c === '-' && next === '-' && /^\s?$/.test(sql[i + 2] ?? '')) || (c === '/' && next === '*')) {
      const isBlock = c === '/'
      if (isBlock && /^[!M]/.test(sql[i + 2] ?? '')) isExecutable = true
      end = isBlock ? sql.indexOf('*/', i + 2) : sql.indexOf('\n', i)
      end = end === -1 ? sql.length : isBlock ? end + 2 : end
      mask += blank(sql.slice(i, end))
      clean += blank(sql.slice(i, end))
    } else {
      mask += c
      clean += c
    }
    i = end
  }

  return { mask, clean, isExecutable }
}

// A ```sql block run read-only: its first line names the database (`-- db: name`), one reading statement,
// or a DELETE / UPDATE simulated as the SELECT of the rows it would touch.
export function sqlTarget(text: string): SqlTarget | string {
  const db = text.match(/^\s*--\s*db:\s*([\w$]+)\s*$/m)?.[1]
  if (!db) return 'First line expected: -- db: <database>'
  const query = text
    .replace(/^\s*--.*$/gm, '')
    .trim()
    .replace(/;\s*$/, '')
  // Strings and comments out of the way before looking at what the statement does.
  // A comment separates tokens: as a space, `INTO/**/OUTFILE` still reads as INTO OUTFILE.
  const { mask: bare, clean, isExecutable } = scanSql(query)
  // The client runs `\! cmd` as a shell command and `\. file` as a script, and the server runs
  // `/*! … */` as code: none of them is a reading statement.
  if (bare.includes('\\')) return 'No client command (\\…)'
  if (isExecutable) return 'No executable comment (/*! … */)'
  if (/^\s*delimiter\b/im.test(bare)) return 'No client command (delimiter)'
  if (bare.includes(';')) return 'One statement at a time'
  if (/\b(into\s+(out|dump)file|for\s+update|lock\s+in\s+share\s+mode)\b/i.test(bare)) return 'Read-only: no INTO OUTFILE and no locks'
  // Root reads any file the server can: a SELECT from a reply must stay inside the database.
  if (/\bload_file\s*\(/i.test(bare)) return 'Read-only: no LOAD_FILE'
  if (/^\s*(delete|update)\b/i.test(bare)) {
    // Same length as the query: positions found in the mask cut the query.
    const simulated = simulation(clean, bare)
    if (typeof simulated === 'string') return simulated

    return { db, query: simulated.query, simulates: { verb: simulated.verb, statement: query, hasWhere: simulated.hasWhere } }
  }
  if (!/^\s*(select|with|show|describe|desc|explain)\b/i.test(bare)) return 'Read-only: SELECT, WITH, SHOW, DESCRIBE or EXPLAIN; DELETE and UPDATE run as a simulation'

  return { db, query }
}

// `mysql --batch` output: tab-separated, first line the columns, \t \n \\ escaped, NULL bare.
export function parseTsv(stdout: string): { columns: string[]; rows: string[][] } {
  const unescape = (cell: string) => cell.replace(/\\(.)/g, (_, c: string) => ({ t: '\t', n: '\n', '0': '\0' })[c] ?? c)
  const [head = '', ...lines] = stdout.replace(/\n$/, '').split('\n')
  if (head === '') return { columns: [], rows: [] }

  return { columns: head.split('\t').map(unescape), rows: lines.map(line => line.split('\t').map(unescape)) }
}

// A result as a markdown table, cells one line and capped, at most `max` rows.
export function markdownTable(columns: string[], rows: string[][], max = 50, width = 40): string {
  const cell = (value: string) => {
    const flat = value.replace(/\s+/g, ' ').replace(/\|/g, '\\|')
    return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
  }
  const line = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`

  return [line(columns), `|${columns.map(() => '---').join('|')}|`, ...rows.slice(0, max).map(line)].join('\n')
}

// --- REST client ---

const RESPONSE_MARK = '__RR_RESPONSE__'

// A plain curl call (no pipe or chaining) run with its status line, headers and timing; undefined otherwise.
export function withResponseInfo(command: string): string | undefined {
  if (!/^\s*curl\s/.test(command) || /[|;&>\n]|\$\(/.test(command.replace(/'[^']*'|"[^"]*"/g, ''))) return undefined

  return command.replace(/^\s*curl\s/, `curl -i -sS -w '\\n${RESPONSE_MARK} %{http_code} %{time_total} %{size_download}\\n' `)
}

export type HttpResponse = { status: number; statusText: string; headers: [string, string][]; body: string; ms: number; bytes: number }

// curl -i output: the last header block (after redirects or 100-continue), then the body, then our -w line.
export function parseHttpResponse(output: string): HttpResponse | undefined {
  const mark = output.match(new RegExp(`\\n?${RESPONSE_MARK} (\\d+) ([\\d.]+) (\\d+)\\s*$`))
  if (!mark) return undefined
  let rest = output.slice(0, mark.index).replace(/\r/g, '')
  let statusLine = ''
  let headers: [string, string][] = []
  while (/^HTTP\/[\d.]+ \d+/.test(rest)) {
    const end = rest.indexOf('\n\n')
    const block = end < 0 ? rest : rest.slice(0, end)
    rest = end < 0 ? '' : rest.slice(end + 2)
    const [first = '', ...lines] = block.split('\n')
    statusLine = first
    headers = lines.map(line => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()] as [string, string])
  }

  return {
    status: Number(mark[1]),
    statusText: statusLine.replace(/^HTTP\/[\d.]+ \d+\s*/, ''),
    headers,
    body: rest,
    ms: Math.round(Number(mark[2]) * 1000),
    bytes: Number(mark[3]),
  }
}

// --- JSON viewer ---

export type JsonLine = { path: string; depth: number; key: string; text: string; kind: 'string' | 'number' | 'boolean' | 'null' | 'open' | 'close' | 'folded'; isFoldable: boolean }

// Default fold: the first two levels open, deeper ones closed until clicked.
export const isOpenByDefault = (path: string) => path.split('/').length <= 2

// A JSON value as display lines; `isOpen(path)` decides each object or array, `max` caps the lines.
export function jsonLines(value: unknown, isOpen: (path: string) => boolean, max = 300): JsonLine[] {
  const lines: JsonLine[] = []
  const walk = (node: unknown, path: string, depth: number, key: string, isLast: boolean) => {
    if (lines.length >= max) return
    const comma = isLast ? '' : ','
    if (node !== null && typeof node === 'object') {
      const entries = Array.isArray(node) ? node.map((item, n) => [String(n), item] as const) : Object.entries(node)
      const [open, close] = Array.isArray(node) ? ['[', ']'] : ['{', '}']
      if (entries.length === 0) return void lines.push({ path, depth, key, text: `${open}${close}${comma}`, kind: 'null', isFoldable: false })
      if (!isOpen(path)) {
        const size = Array.isArray(node) ? `${entries.length} item${entries.length > 1 ? 's' : ''}` : `${entries.length} key${entries.length > 1 ? 's' : ''}`
        return void lines.push({ path, depth, key, text: `${open}…${close} ${size}${comma}`, kind: 'folded', isFoldable: true })
      }
      lines.push({ path, depth, key, text: open, kind: 'open', isFoldable: true })
      entries.forEach(([childKey, child], n) => walk(child, `${path}/${childKey}`, depth + 1, Array.isArray(node) ? '' : childKey, n === entries.length - 1))
      lines.push({ path: `${path}/$close`, depth, key: '', text: `${close}${comma}`, kind: 'close', isFoldable: false })
      return
    }
    const kind = node === null ? 'null' : typeof node === 'string' ? 'string' : typeof node === 'number' ? 'number' : 'boolean'
    lines.push({ path, depth, key, text: `${JSON.stringify(node)}${comma}`, kind, isFoldable: false })
  }
  walk(value, '$', 0, '', true)

  return lines
}

// Every object or array path of a value, for reading their fold state before drawing.
export function jsonFoldPaths(value: unknown, max = 300): string[] {
  const paths: string[] = []
  const walk = (node: unknown, path: string) => {
    if (paths.length >= max || node === null || typeof node !== 'object') return
    paths.push(path)
    for (const [key, child] of Array.isArray(node) ? node.map((item, n) => [String(n), item] as const) : Object.entries(node)) walk(child, `${path}/${key}`)
  }
  walk(value, '$')

  return paths
}

export function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

// --- Image preview ---

export const isImagePath = (path: string) => /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i.test(path.replace(/:\d+(:\d+)?$/, ''))
