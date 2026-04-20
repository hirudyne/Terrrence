// Shared types for conversation schema

export interface ConvLine {
  id: string
  speaker: string            // ##CharName## token
  text: string
  audio: number | null
  prerequisite: string | null  // event slug - line hidden until fired
  blocker: string | null       // event slug - line hidden after fired
  triggers: string | null      // event slug - fired when this line is said
  next: ConvLine[]             // >1 available = menu; 1 = auto-advance; 0 = end
}

export interface ConvData {
  lines: ConvLine[]
}

export function emptyConvData(): ConvData {
  return { lines: [] }
}

export function emptyLine(id: string): ConvLine {
  return { id, speaker: '', text: '', audio: null, prerequisite: null, blocker: null, triggers: null, next: [] }
}

// --- ID generation ---
export function deriveConvId(base: string, existing: string[]): string {
  const slug = base.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'line'
  let n = 1
  let candidate = `${slug}_${String(n).padStart(3, '0')}`
  while (existing.includes(candidate)) { n++; candidate = `${slug}_${String(n).padStart(3, '0')}` }
  return candidate
}

export function allIds(lines: ConvLine[]): string[] {
  const ids: string[] = []
  function collect(ls: ConvLine[]) {
    for (const l of ls) { ids.push(l.id); collect(l.next) }
  }
  collect(lines)
  return ids
}

// --- Find a line by id (recursive) ---
export function findLine(lines: ConvLine[], id: string): ConvLine | null {
  for (const l of lines) {
    if (l.id === id) return l
    const found = findLine(l.next, id)
    if (found) return found
  }
  return null
}

// --- Serialisation ---
export function parseConvBody(body: string): ConvData {
  if (!body || !body.trim()) return emptyConvData()
  try {
    const parsed = JSON.parse(body)
    if (Array.isArray(parsed.lines)) return { lines: parsed.lines }
    // legacy migration: flatten old greetings/menu into lines[]
    const lines: ConvLine[] = []
    return { lines }
  } catch (_) { return emptyConvData() }
}

export function serializeConvBody(data: ConvData): string {
  return JSON.stringify(data, null, 2)
}
