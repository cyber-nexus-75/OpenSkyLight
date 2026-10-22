import { describe, expect, it } from 'vitest'
import {
  createAiService,
  extractJson,
  chatFetch,
  type ChatFetch
} from '../../src/main/services/aiService'
import type { SettingsService } from '../../src/main/services/settingsService'

/** Stub transport — no live AI endpoint involved. */

function settingsStub(): SettingsService & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    getRaw: (key: string) => store.get(key) ?? null,
    setRaw: (key: string, value: string) => void store.set(key, value),
    deleteRaw: (key: string) => void store.delete(key),
    getAll: () => ({}) as never,
    set: () => ({}) as never
  } as SettingsService & { store: Map<string, string> }
}

const GOOD_REPLY = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          events: [
            {
              title: 'Soccer practice',
              date: '2026-03-10',
              startTime: '16:30',
              endTime: '17:30',
              allDay: false,
              location: 'Field 2',
              description: null,
              repeat: 'weekly',
              note: 'Assumed the 2026 season start'
            },
            {
              title: 'No school',
              date: '2026-04-01',
              startTime: null,
              endTime: null,
              allDay: true,
              location: null,
              description: 'Teacher workday',
              repeat: null,
              note: null
            }
          ]
        })
      }
    }
  ]
}

function okTransport(seen: { url: string; body: unknown; apiKey: string }[] = []): ChatFetch {
  return async (url, body, apiKey) => {
    seen.push({ url, body, apiKey })
    return GOOD_REPLY
  }
}

describe('aiService', () => {
  it('is unconfigured until setConfig succeeds', () => {
    const ai = createAiService({ settings: settingsStub() })
    expect(ai.getStatus().configured).toBe(false)
    expect(ai.importEvents({ text: 'x', images: [], tz: 'UTC' })).rejects.toThrow()
  })

  it('setConfig validates URL and model shapes', () => {
    const ai = createAiService({ settings: settingsStub() })
    expect(() => ai.setConfig({ endpointUrl: 'ftp://nope', model: 'm', apiKey: 'k' })).toThrow(/http/)
    expect(() =>
      ai.setConfig({ endpointUrl: 'https://api.mistral.ai/v1/chat/completions', model: 'bad model!', apiKey: 'k' })
    ).toThrow(/model/i)
  })

  it('imports drafts from a model reply — text-only and with attachments', async () => {
    const settings = settingsStub()
    const ai = createAiService({ settings })
    ai.setConfig({ endpointUrl: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest', apiKey: 'sk-test' })
    expect(ai.getStatus()).toEqual({
      configured: true,
      endpointUrl: 'https://api.mistral.ai/v1/chat/completions',
      model: 'mistral-small-latest'
    })

    const seen: { url: string; body: unknown; apiKey: string }[] = []
    const drafts = await ai.importEvents(
      { text: 'Soccer Tuesdays 4:30pm starting this week', images: [], tz: 'America/Denver' },
      okTransport(seen)
    )
    expect(drafts.length).toBe(2)
    expect(drafts[0]).toMatchObject({ title: 'Soccer practice', startTime: '16:30', repeat: 'weekly' })

    // request shape: OpenAI-compatible chat completions with today + timezone in the prompt
    expect(seen[0].url).toBe('https://api.mistral.ai/v1/chat/completions')
    expect(seen[0].apiKey).toBe('sk-test')
    const body = seen[0].body as { model: string; messages: { role: string; content: unknown }[] }
    expect(body.model).toBe('mistral-small-latest')
    expect(String(body.messages[1].content)).toContain('America/Denver')

    // with an image attachment → multimodal content array with data URLs
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    await ai.importEvents({ text: 'flyer', images: [png], tz: 'UTC' }, okTransport(seen))
    const content = (seen[1].body as { messages: { content: unknown }[] }).messages[1].content
    expect(Array.isArray(content)).toBe(true)
    expect((content as { type: string }[]).some((p) => p.type === 'image_url')).toBe(true)

    // unsupported attachment kind rejected
    await expect(ai.importEvents({ text: 'x', images: ['!!notbase64'], tz: 'UTC' }, okTransport())).rejects.toThrow(
      /PNG, JPEG/
    )

    // WebP is advertised as supported and must sniff to image/webp
    const webp = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='
    await ai.importEvents({ text: 'flyer', images: [webp], tz: 'UTC' }, okTransport(seen))
    const webpContent = (seen[seen.length - 1].body as { messages: { content: unknown }[] }).messages[1].content as {
      type: string
      image_url: { url: string }
    }[]
    const imagePart = webpContent.find((p) => p.type === 'image_url')!
    expect(imagePart.image_url.url.startsWith('data:image/webp;base64,')).toBe(true)
  })

  it('rejects empty input, >5 attachments, and bad model replies', async () => {
    const ai = createAiService({ settings: settingsStub() })
    ai.setConfig({ endpointUrl: 'https://x/v1/chat/completions', model: 'm', apiKey: 'k' })
    await expect(ai.importEvents({ text: '   ', images: [], tz: 'UTC' }, okTransport())).rejects.toThrow(/Paste text/)
    await expect(
      ai.importEvents({ text: 'x', images: ['a', 'b', 'c', 'd', 'e', 'f'], tz: 'UTC' }, okTransport())
    ).rejects.toThrow(/5 attachments/)

    const badShape: ChatFetch = async () => ({ choices: [{ message: { content: '{"nope":1}' } }] })
    await expect(ai.importEvents({ text: 'x', images: [], tz: 'UTC' }, badShape)).rejects.toThrow(/shape/)

    const notJson: ChatFetch = async () => ({ choices: [{ message: { content: 'I cannot do that' } }] })
    await expect(ai.importEvents({ text: 'x', images: [], tz: 'UTC' }, notJson)).rejects.toThrow(/JSON/)

    const empty: ChatFetch = async () => ({ choices: [{ message: { content: '' } }] })
    await expect(ai.importEvents({ text: 'x', images: [], tz: 'UTC' }, empty)).rejects.toThrow(/empty reply/)

    const garbled: ChatFetch = async () => ({ choices: [{ message: { content: '{"events":[{"title":"x","date":"1999-01-01","startTime":null,"endTime":null,"allDay":true,"location":null,"description":null,"repeat":null,"note":null}]}' } }] })
    const drafts = await ai.importEvents({ text: 'x', images: [], tz: 'UTC' }, garbled)
    expect(drafts).toEqual([]) // out-of-window dates are dropped, not committed
  })

  it('coerces timed drafts missing a start time to all-day, with a note', async () => {
    const ai = createAiService({ settings: settingsStub() })
    ai.setConfig({ endpointUrl: 'https://x/v1/chat/completions', model: 'm', apiKey: 'k' })
    const reply = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              events: [
                { title: 'Vague thing', date: '2026-03-10', startTime: null, endTime: null, allDay: false, location: null, description: null, repeat: null, note: null }
              ]
            })
          }
        }
      ]
    }
    const transport: ChatFetch = async () => reply
    const drafts = await ai.importEvents({ text: 'sometime next week', images: [], tz: 'UTC' }, transport)
    expect(drafts[0]).toMatchObject({ allDay: true, endTime: null })
    expect(drafts[0].note).toMatch(/marked all-day/)
  })

  it('clearConfig wipes credentials', async () => {
    const settings = settingsStub()
    const ai = createAiService({ settings })
    ai.setConfig({ endpointUrl: 'https://x/v1/chat/completions', model: 'm', apiKey: 'k' })
    ai.clearConfig()
    expect(ai.getStatus().configured).toBe(false)
    expect(settings.store.has('ai.apiKeyEnc')).toBe(false)
  })
})

describe('extractJson', () => {
  it('takes the outermost JSON object from fenced or prose-wrapped replies', () => {
    expect(extractJson('```json\n{"events":[]}\n```')).toEqual({ events: [] })
    expect(extractJson('Sure! Here it is: {"events":[]} hope that helps')).toEqual({ events: [] })
    expect(() => extractJson('no json here')).toThrow()
  })
})

describe('chatFetch error mapping', () => {
  it('maps status codes to typed errors', async () => {
    const mk = (status: number): Promise<Response> => Promise.resolve(new Response('x', { status }))
    const origFetch = global.fetch
    for (const [status, re] of [
      [401, /API key/],
      [404, /Endpoint URL or model/]
    ] as const) {
      global.fetch = (() => mk(status)) as typeof fetch
      await expect(chatFetch('https://x', {}, 'k')).rejects.toThrow(re)
    }
    global.fetch = origFetch
  })
})
