// World state management for in-editor game preview.
// State is derived by replaying firedEvents in order from a clean initial state.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorldState {
  firedEvents: string[]                      // ordered log - canonical save format
  playerCharacter: string | null             // character slug
  characterPositions: Record<string, string> // charSlug -> spotSlug
  inventory: string[]                        // itemSlug[]
}

export interface EventEntity {
  slug: string
  trigger: string   // e.g. "LineSaid_line_001"
  effect: string    // e.g. "CharMove_sholver_old_barn_door"
}

// ---------------------------------------------------------------------------
// Effect parsing
// ---------------------------------------------------------------------------

export type Effect =
  | { type: 'CharPossess'; charSlug: string }
  | { type: 'ObstacleRemoved'; spotSlug: string }
  | { type: 'ObstacleAdded'; spotSlug: string }
  | { type: 'ItemGained'; itemSlug: string }
  | { type: 'ItemLost'; itemSlug: string }
  | { type: 'CharMove'; charSlug: string; spotSlug: string }
  | { type: 'Unknown'; raw: string }

export function parseEffect(raw: string): Effect {
  if (!raw) return { type: 'Unknown', raw }
  const s = raw.trim()
  if (s.startsWith('CharPossess_')) return { type: 'CharPossess', charSlug: s.slice(12) }
  if (s.startsWith('ObstacleRemoved_')) return { type: 'ObstacleRemoved', spotSlug: s.slice(16) }
  if (s.startsWith('ObstacleAdded_')) return { type: 'ObstacleAdded', spotSlug: s.slice(14) }
  if (s.startsWith('ItemGained_')) return { type: 'ItemGained', itemSlug: s.slice(11) }
  if (s.startsWith('ItemLost_')) return { type: 'ItemLost', itemSlug: s.slice(9) }
  if (s.startsWith('CharMove_')) {
    // CharMove_<charSlug>__<spotSlug> - double-underscore separator to avoid ambiguity
    // (both slugs may themselves contain single underscores)
    const rest = s.slice(9) // after 'CharMove_'
    const sep = rest.indexOf('__')
    if (sep === -1) return { type: 'Unknown', raw }
    return { type: 'CharMove', charSlug: rest.slice(0, sep), spotSlug: rest.slice(sep + 2) }
  }
  return { type: 'Unknown', raw }
}

export function parseTrigger(raw: string): { type: 'LineSaid'; lineId: string } | { type: 'Unknown'; raw: string } {
  if (!raw) return { type: 'Unknown', raw }
  const s = raw.trim()
  if (s.startsWith('LineSaid_')) return { type: 'LineSaid', lineId: s.slice(9) }
  return { type: 'Unknown', raw: s }
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function initialState(playerCharacter: string | null): WorldState {
  return {
    firedEvents: [],
    playerCharacter,
    characterPositions: {},
    inventory: [],
  }
}

// ---------------------------------------------------------------------------
// Reducer - apply a single event's effect to world state
// ---------------------------------------------------------------------------

export function applyEffect(state: WorldState, eventSlug: string, effect: Effect): WorldState {
  const next: WorldState = {
    firedEvents: [...state.firedEvents, eventSlug],
    playerCharacter: state.playerCharacter,
    characterPositions: { ...state.characterPositions },
    inventory: [...state.inventory],
  }
  switch (effect.type) {
    case 'CharPossess':
      next.playerCharacter = effect.charSlug
      break
    case 'ObstacleRemoved':
    case 'ObstacleAdded':
      // Obstacle state is derived from firedEvents at query time - no extra field needed
      break
    case 'ItemGained':
      if (!next.inventory.includes(effect.itemSlug)) next.inventory.push(effect.itemSlug)
      break
    case 'ItemLost':
      next.inventory = next.inventory.filter(s => s !== effect.itemSlug)
      break
    case 'CharMove':
      next.characterPositions[effect.charSlug] = effect.spotSlug
      break
    case 'Unknown':
      console.warn('[terrrence] unknown effect:', effect.raw)
      break
  }
  return next
}

// ---------------------------------------------------------------------------
// Replay - rebuild world state from an event log
// ---------------------------------------------------------------------------

export function replayEvents(eventLog: string[], allEvents: EventEntity[], playerCharacter: string | null): WorldState {
  let state = initialState(playerCharacter)
  for (const slug of eventLog) {
    const ev = allEvents.find(e => e.slug === slug)
    if (!ev) continue
    const effect = parseEffect(ev.effect)
    state = applyEffect(state, slug, effect)
  }
  return state
}

// ---------------------------------------------------------------------------
// Prerequisite evaluation
// ---------------------------------------------------------------------------

// Returns true if the line should be visible given current world state.
export function lineVisible(
  prerequisite: string | null,
  blocker: string | null,
  firedEvents: string[]
): boolean {
  if (prerequisite && !firedEvents.includes(prerequisite)) return false
  if (blocker && firedEvents.includes(blocker)) return false
  return true
}

// ---------------------------------------------------------------------------
// Obstacle query
// ---------------------------------------------------------------------------

// A spot is blocked if the most recent ObstacleAdded/ObstacleRemoved event for it
// left it in an added state.
export function spotBlocked(spotSlug: string, firedEvents: string[], allEvents: EventEntity[]): boolean {
  // Walk events in reverse, return on first match
  for (let i = firedEvents.length - 1; i >= 0; i--) {
    const ev = allEvents.find(e => e.slug === firedEvents[i])
    if (!ev) continue
    const effect = parseEffect(ev.effect)
    if (effect.type === 'ObstacleRemoved' && effect.spotSlug === spotSlug) return false
    if (effect.type === 'ObstacleAdded' && effect.spotSlug === spotSlug) return true
  }
  return false  // no obstacle events = not blocked
}

// ---------------------------------------------------------------------------
// Fire an event - validate cause, return new state or null if cause not met
// ---------------------------------------------------------------------------

export function fireEvent(
  eventSlug: string,
  allEvents: EventEntity[],
  state: WorldState,
  causeContext: { type: 'LineSaid'; lineId: string } | null
): WorldState | null {
  const ev = allEvents.find(e => e.slug === eventSlug)
  if (!ev) return null
  const trigger = parseTrigger(ev.trigger)
  if (trigger.type === 'LineSaid') {
    if (!causeContext || causeContext.type !== 'LineSaid' || causeContext.lineId !== trigger.lineId) return null
  }
  const effect = parseEffect(ev.effect)
  return applyEffect(state, eventSlug, effect)
}
