// Shared types for conversation schema

export interface ConvLine {
  speaker: string   // ##CharName## token
  text: string
  audio: number | null
}

export interface ConvOption {
  id: string
  label: string
  prerequisite: string | null
  triggers: string | null
  lines: ConvLine[]
  response_menu: ConvOption[]
}

export interface ConvGreeting {
  id: string
  prerequisite: string | null
  lines: ConvLine[]
}

export interface ConvData {
  greetings: ConvGreeting[]
  menu: ConvOption[]
}

export function emptyConvData(): ConvData {
  return { greetings: [], menu: [] }
}

// --- ID generation ---
// Derive a slug from label, then suffix _001, _002 etc. to ensure uniqueness
export function deriveConvId(label: string, existing: string[]): string {
  const base = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'item'
  let n = 1
  let candidate = `${base}_${String(n).padStart(3, '0')}`
  while (existing.includes(candidate)) {
    n++
    candidate = `${base}_${String(n).padStart(3, '0')}`
  }
  return candidate
}

export function allIds(data: ConvData): string[] {
  const ids: string[] = []
  for (const g of data.greetings) ids.push(g.id)
  function collectOpt(opts: ConvOption[]) {
    for (const o of opts) { ids.push(o.id); collectOpt(o.response_menu) }
  }
  collectOpt(data.menu)
  return ids
}

// --- YAML serialisation (minimal, no external dep) ---
function yamlStr(s: string): string {
  if (!s) return '""'
  if (/[:{}\[\],&*#?|<>=!%@`\n\r"']/.test(s) || s.trim() !== s) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
  }
  return s
}

function yamlNull(v: string | number | null): string {
  if (v === null || v === '') return 'null'
  return yamlStr(String(v))
}

function serializeLines(lines: ConvLine[], indent: string): string {
  return lines.map(l =>
    `${indent}- speaker: ${yamlStr(l.speaker)}\n` +
    `${indent}  text: ${yamlStr(l.text)}\n` +
    `${indent}  audio: ${l.audio === null ? 'null' : l.audio}\n`
  ).join('')
}

function serializeOptions(opts: ConvOption[], indent: string): string {
  return opts.map(o =>
    `${indent}- id: ${yamlStr(o.id)}\n` +
    `${indent}  label: ${yamlStr(o.label)}\n` +
    `${indent}  prerequisite: ${yamlNull(o.prerequisite)}\n` +
    `${indent}  triggers: ${yamlNull(o.triggers)}\n` +
    `${indent}  lines:\n` +
    (o.lines.length ? serializeLines(o.lines, indent + '    ') : `${indent}    []\n`) +
    `${indent}  response_menu:\n` +
    (o.response_menu.length ? serializeOptions(o.response_menu, indent + '    ') : `${indent}    []\n`)
  ).join('')
}

export function serializeConvData(data: ConvData): string {
  let out = 'greetings:\n'
  if (data.greetings.length === 0) {
    out += '  []\n'
  } else {
    out += data.greetings.map(g =>
      `  - id: ${yamlStr(g.id)}\n` +
      `    prerequisite: ${yamlNull(g.prerequisite)}\n` +
      `    lines:\n` +
      (g.lines.length ? serializeLines(g.lines, '      ') : '      []\n')
    ).join('')
  }
  out += 'menu:\n'
  if (data.menu.length === 0) {
    out += '  []\n'
  } else {
    out += serializeOptions(data.menu, '  ')
  }
  return out
}

// --- YAML parsing (simple, handles our own output format) ---
// We rely on the server having stored valid YAML and returning it via getEntity body.
// Parse using a lightweight approach: js-yaml is not available, so we use JSON
// via a backend round-trip. Instead we store as JSON in the body for simplicity.
// Actually: we'll store as JSON wrapped in a YAML code fence for human readability
// but parse as JSON. See note in pane-conversation.ts.

export function parseConvBody(body: string): ConvData {
  if (!body || !body.trim()) return emptyConvData()
  try {
    // Body stored as JSON
    const parsed = JSON.parse(body)
    return {
      greetings: Array.isArray(parsed.greetings) ? parsed.greetings : [],
      menu: Array.isArray(parsed.menu) ? parsed.menu : [],
    }
  } catch (_) {
    return emptyConvData()
  }
}

export function serializeConvBody(data: ConvData): string {
  return JSON.stringify(data, null, 2)
}
