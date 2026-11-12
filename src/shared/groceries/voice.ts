import { parseSpokenItem } from './normalize'

/**
 * Voice command parsing, shared by the kiosk renderer and the phone companion
 * (both use the browser's SpeechRecognition). Transcripts are parsed into a
 * small command union the caller executes against the IPC API.
 */

export type VoiceCommand =
  | { type: 'addToList'; item: string; quantity: number; unit: string | null }
  | { type: 'outOf'; item: string }
  | { type: 'used'; item: string; quantity: number; unit: string | null }
  | { type: 'bought'; item: string; quantity: number; unit: string | null }
  | { type: 'lowStock' }
  | { type: 'pantryQuery' }
  | { type: 'shoppingQuery' }
  | { type: 'prepareFrys' }
  | { type: 'clearList' }
  | { type: 'scanReceipt' }
  | { type: 'unknown'; text: string }

const FILLER_START = /^(hey |ok(ay)? |please |can you |could you |i need |we need to |let'?s )/i
const LIST_TAIL = /\s+to (?:the |our |my )?(?:shopping |grocery )?list\s*$/i
const WEEK_TAIL = /\s+for (?:the )?week\s*$/i

function stripTail(text: string): string {
  return text.replace(LIST_TAIL, '').replace(WEEK_TAIL, '').trim()
}

function itemAfter(match: RegExpMatchArray | null): string {
  return stripTail((match?.[1] ?? '').replace(FILLER_START, '').trim())
}

export function parseVoiceCommand(raw: string): VoiceCommand {
  const text = raw.trim().replace(/\s+/g, ' ')
  if (!text) return { type: 'unknown', text: raw }
  const lower = text.toLowerCase().replace(/[.!?]+$/g, '')

  if (/\b(scan|photo(?:graph)?|picture)\b.*\breceipt\b|\breceipt\b.*\b(scan|photo)\b|\bscan (?:the )?receipt\b|\btake (?:a )?(?:pic|picture|photo) of (?:the )?receipt\b/i.test(lower)) {
    return { type: 'scanReceipt' }
  }
  if (/\bclear (?:the )?(?:shopping |grocery )?list\b|\bempty (?:the )?(?:shopping |grocery )?list\b|\bremove everything from (?:the )?list\b/i.test(lower)) {
    return { type: 'clearList' }
  }
  if (/\bfrys\b|\bfry'?s\b|\bkroger\b/i.test(lower)) {
    return { type: 'prepareFrys' }
  }
  if (/what'?s (?:low|running out)|what are we (?:running )?out of|low stock|\bwhat'?s on (?:the )?(?:shopping )?list\b|what do we need\b/i.test(lower)) {
    return /list|need/.test(lower) ? { type: 'shoppingQuery' } : { type: 'lowStock' }
  }
  const addToPantry = lower.match(/^add\s+(.+?)\s+to (?:the )?pantry$/i)
  if (addToPantry) {
    const q = parseSpokenItem(itemAfter(addToPantry))
    return { type: 'bought', item: q.rest, quantity: q.quantity, unit: q.unit }
  }

  const outOf = lower.match(/\b(?:we'?re |we are |i'?m |i am )?(?:out of|ran out of|running low on|low on)\s+(.+)$/i)
  if (outOf) {
    const item = itemAfter(outOf)
    if (item) return { type: 'outOf', item }
  }

  const used = lower.match(/\b(?:we |i )?used (?:up )?(.+)$/i)
  if (used) {
    const item = itemAfter(used)
    if (item) {
      const q = parseSpokenItem(item)
      return { type: 'used', item: q.rest, quantity: q.quantity, unit: q.unit }
    }
  }

  const bought = lower.match(/\b(?:we |i )?(?:bought|got|picked up|purchased)\s+(.+)$/i)
  if (bought) {
    const item = itemAfter(bought)
    if (item) {
      const q = parseSpokenItem(item)
      return { type: 'bought', item: q.rest, quantity: q.quantity, unit: q.unit }
    }
  }

  if (/what do we have|what'?s in (?:the )?pantry|how much (.+?) (?:do we have|is left|we have)/i.test(lower)) {
    return { type: 'pantryQuery' }
  }

  const add = lower.replace(FILLER_START, '').match(/^(?:add|put|get|grab|buy|pick up|we need|give me)\s+(.+)$/i)
  if (add) {
    const item = itemAfter(add)
    if (item) {
      const q = parseSpokenItem(item)
      return { type: 'addToList', item: q.rest, quantity: q.quantity, unit: q.unit }
    }
  }

  return { type: 'unknown', text: raw }
}
