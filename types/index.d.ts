export type DetailsOpen = boolean

export type Run = {
  command: string
  // Which command line of which reply launched it: the output draws under that line only.
  origin: string
  status: 'confirm' | 'running' | 'done' | 'stopped'
  output: string
  code: number | null
}

// One hunk of a /changes row, after a click: staged in the index, reverted in the tree, or asking first.
// Unstage and Restore take it back to null, the row's initial state.
export type HunkState = 'staged' | 'confirm' | 'reverted' | 'failed'

export type CheckState = 'ok' | 'fail' | 'pending' | 'skip'
export type Check = { name: string; state: CheckState; url: string }

// The current branch's PR as /pr draws it, refreshed while checks run.
export type PrCard = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  mergeable: string
  reviewDecision: string
  checks: Check[]
  reviews: { author: string; state: string; body: string }[]
}

// A ▶ on a ```sql block: its read-only run and result, drawn under that block only.
export type SqlRun = {
  origin: string
  status: 'running' | 'done' | 'error'
  db: string
  table: string
  tsv: string
  count: number
  ms: number
  message: string
  // A DELETE / UPDATE run as the SELECT of the rows it would touch: `touched` counts them all.
  simulation: { verb: 'DELETE' | 'UPDATE'; touched: number; hasWhere: boolean } | null
}

// What the linter said about a file right after Edit or Write wrote it.
export type Problems = { tool: string; lines: string[] }

declare module 'claude-code' {
  interface PluginState {
    'rich-replies': {
      open: StateFamily<DetailsOpen>
      // A command line's run, by its origin: several stay on screen at once.
      run: StateFamily<Run | null>
      runRows: StateFamily<number | null>
      duration: StateFamily<number | null>
      // A failed tool call's text as the model read it: the error lens and stack links draw from it.
      failure: StateFamily<string | null>
      hunk: StateFamily<HunkState | null>
      pr: PrCard | null
      // A watched /snap picture's redraw count, by its path: the Image reads it as its generation.
      snapGeneration: StateFamily<number | null>
      // The path of the /snap picture being watched, if any.
      snapWatched: string | null
      problems: StateFamily<Problems | null>
      sql: SqlRun | null
      // A JSON viewer node's fold, by its path; null follows the default (first two levels open).
      fold: StateFamily<boolean | null>
    }
  }
}
