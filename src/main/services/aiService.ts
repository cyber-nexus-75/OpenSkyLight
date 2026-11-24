import { safeStorage } from 'electron'
import { DateTime } from 'luxon'
import { z } from 'zod'
import type { SettingsService } from './settingsService'
import type { AiEventDraft } from '@shared/types'
import { AppError, invalid } from './errors'

/**
 * AI import: converts messy inputs (pasted text, photos/PDFs of flyers) into
 * event DRAFTS for a review screen. Never auto-commits — the caller confirms,
 * edits, or discards each draft through the normal events:create pipeline.
 *
 * Works against any OpenAI-compatible endpoint (Mistral API, or a LAN-hosted
 * server like Ollama behind a reverse proxy). The API key is
 * safeStorage/DPAPI-encrypted in main and never crosses to the renderer.
 */

const KEY_URL = 'ai.endpointUrl'
const KEY_MODEL = 'ai.model'
const KEY_API_KEY_ENC = 'ai.apiKeyEnc'

export interface AiConfigStatus {
  configured: boolean
  endpointUrl: string | null
  model: string | null
}

export interface AiImportInput {
  text: string
  /** base64-encoded image/PDF attachments (JPEG/PNG/WebP/PDF) */
  images: string[]
  /** IANA zone to resolve relative dates in */
  tz: string
}

function encryptSecret(plain: string): string {
  const available = (() => {
    try {
      return safeStorage?.isEncryptionAvailable() ?? false
    } catch {
      return false
    }
  })()
  const buf = available ? safeStorage.encryptString(plain) : Buffer.from(`plain:${plain}`, 'utf8')
  return buf.toString('base64')
}

function decryptSecret(b64: string): string {
  const buf = Buffer.from(b64, 'base64')
  const asString = buf.toString('utf8')
  if (asString.startsWith('plain:')) return asString.slice(6)
  return safeStorage.decryptString(buf)
}

/** Model output contract — a JSON array of drafts. Zod-validated. */
const draftSchema = z.object({
  title: z.string().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  allDay: z.boolean(),
  location: z.string().max(300).nullable(),
  description: z.string().max(2000).nullable(),
  repeat: z.enum(['daily', 'weekly', 'monthly', 'yearly']).nullable(),
  note: z.string().max(300).nullable()
})
const modelReplySchema = z.object({ events: z.array(draftSchema).max(30) })

export const SYSTEM_PROMPT = `You are a calendar assistant. Extract upcoming events from the user's input
(emails, schedule text, photos of flyers or printed schedules). Today's date and the user's timezone
are given in the user message. Reply with ONLY a JSON object of this exact shape — no prose, no code fences:
{"events":[{"title":string,"date":"YYYY-MM-DD","startTime":"HH:MM"|null,"endTime":"HH:MM"|null,"allDay":boolean,"location":string|null,"description":string|null,"repeat":"daily"|"weekly"|"monthly"|"yearly"|null,"note":string|null}]}
Rules: resolve relative dates ("next Tuesday") using the given today/timezone; use 24h local time;
all-day events have null times and allDay=true; leave repeat null unless the input clearly states
recurrence; put anything you are unsure about in "note" rather than guessing; return {"events":[]} if
the input contains no events.`

export type ChatFetch = (url: string, body: unknown, apiKey: string) => Promise<unknown>

/** Default transport: OpenAI-compatible chat completions over HTTPS. */
export async function chatFetch(
  url: string,
  body: unknown,
  apiKey: string
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000)
  })
  if (res.status === 401 || res.status === 403) {
    throw new AppError('AI_AUTH', 'The AI endpoint rejected the API key')
  }
  if (res.status === 404) {
    throw new AppError('AI_CONFIG', 'Endpoint URL or model not found — check the settings')
  }
  if (!res.ok) {
    throw new AppError('AI_ERROR', `The AI endpoint returned HTTP ${res.status}`)
  }
  return res.json()
}

export function extractJson(text: string): unknown {
  // models sometimes fence or prepend prose — take the outermost JSON object
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw invalid('The model reply was not JSON')
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    throw invalid('The model reply was not valid JSON')
  }
}

export function createAiService(deps: { settings: SettingsService }) {
  const { settings } = deps

  function getStatus(): AiConfigStatus {
    const url = settings.getRaw(KEY_URL)
    const model = settings.getRaw(KEY_MODEL)
    const key = settings.getRaw(KEY_API_KEY_ENC)
    return {
      configured: url !== null && model !== null && key !== null,
      endpointUrl: url,
      model
    }
  }

  function setConfig(input: { endpointUrl: string; model: string; apiKey: string }): void {
    const url = input.endpointUrl.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(url)) throw invalid('Endpoint URL must be http(s)')
    if (!/^[A-Za-z0-9._\/:-]+$/.test(input.model.trim()) || input.model.trim().length === 0) {
      throw invalid('Model name looks invalid')
    }
    settings.setRaw(KEY_URL, url)
    settings.setRaw(KEY_MODEL, input.model.trim())
    settings.setRaw(KEY_API_KEY_ENC, encryptSecret(input.apiKey.trim()))
  }

  function clearConfig(): void {
    settings.deleteRaw(KEY_URL)
    settings.deleteRaw(KEY_MODEL)
    settings.deleteRaw(KEY_API_KEY_ENC)
  }

  /**
   * Run the import. Returns drafts for a review screen — the CALLER decides
   * what to create, through the normal events:create pipeline.
   */
  async function importEvents(input: AiImportInput, fetchFn: ChatFetch = chatFetch): Promise<AiEventDraft[]> {
    const url = settings.getRaw(KEY_URL)
    const model = settings.getRaw(KEY_MODEL)
    const keyEnc = settings.getRaw(KEY_API_KEY_ENC)
    if (!url || !model || !keyEnc) throw new AppError('AI_CONFIG', 'Configure the AI endpoint first')
    if (!input.text.trim() && input.images.length === 0) throw invalid('Paste text or attach a photo first')
    if (input.images.length > 5) throw invalid('At most 5 attachments')

    const apiKey = decryptSecret(keyEnc)
    const today = DateTime.now().setZone(input.tz).toISODate()!
    const userText = `Today is ${today}. Timezone: ${input.tz}.\n\n${input.text.trim()}`

    const content: Record<string, unknown>[] = [{ type: 'text', text: userText }]
    for (const img of input.images) {
      const kind = sniffKind(img)
      content.push({ type: 'image_url', image_url: { url: `data:${kind};base64,${img}` } })
    }

    const body = {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: content.length === 1 ? userText : content }
      ],
      temperature: 0
    }

    const raw = (await fetchFn(`${url}`, body, apiKey)) as {
      choices?: { message?: { content?: unknown } }[]
    }
    const choiceContent = raw?.choices?.[0]?.message?.content
    const text =
      typeof choiceContent === 'string'
        ? choiceContent
        : // reasoning models may return an array of parts
          Array.isArray(choiceContent)
            ? choiceContent.map((p) => (p as { text?: string }).text ?? '').join('')
            : ''
    if (!text) throw new AppError('AI_ERROR', 'The model returned an empty reply')

    const parsed = modelReplySchema.safeParse(extractJson(text))
    if (!parsed.success) {
      throw new AppError('AI_ERROR', 'The model reply did not match the expected shape')
    }

    // validate dates land in a sane window: today ± 1 year
    const min = DateTime.now().minus({ years: 1 }).toISODate()!
    const max = DateTime.now().plus({ years: 1 }).toISODate()!
    return parsed.data.events
      .filter((e) => e.date >= min && e.date <= max)
      .map((e) => {
        // a timed event without a start time can't be placed — coerce to all-day
        if (!e.allDay && e.startTime === null) {
          return { ...e, allDay: true, endTime: null, note: e.note ? `${e.note} · no time given, marked all-day` : 'No time given — marked all-day' }
        }
        return e
      })
  }

  return { getStatus, setConfig, clearConfig, importEvents }
}

export type AiService = ReturnType<typeof createAiService>

const PNG = 'iVBORw0KGgo'
const JPEG = '/9j/'
const PDF = 'JVBERi'
const WEBP = 'UklGR'

function sniffKind(b64: string): string {
  if (b64.startsWith(PNG)) return 'image/png'
  if (b64.startsWith(JPEG)) return 'image/jpeg'
  if (b64.startsWith(WEBP)) return 'image/webp'
  if (b64.startsWith(PDF)) return 'application/pdf'
  throw invalid('Attachments must be PNG, JPEG, WebP, or PDF')
}
