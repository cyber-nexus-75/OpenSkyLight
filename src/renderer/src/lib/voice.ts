/**
 * Thin wrapper over the Chromium SpeechRecognition API (available in the
 * Electron renderer and in phone browsers). Produces interim + final
 * transcripts; parsing into commands lives in @shared/groceries/voice so the
 * kiosk and the companion speak the same language.
 */

export interface VoiceController {
  supported: boolean
  listening: boolean
  start: (onResult: (transcript: string, isFinal: boolean) => void) => void
  stop: () => void
}

interface RecognitionResultLike {
  isFinal: boolean
  0: { transcript: string }
}
interface RecognitionEventLike {
  results: ArrayLike<RecognitionResultLike>
}
interface RecognitionInstance {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  onresult: ((e: RecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}
type RecognitionCtor = new () => RecognitionInstance

export function createVoiceController(): VoiceController {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor
    webkitSpeechRecognition?: RecognitionCtor
  }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) {
    return { supported: false, listening: false, start: () => {}, stop: () => {} }
  }
  let rec: RecognitionInstance | null = null
  let listening = false
  return {
    supported: true,
    get listening() {
      return listening
    },
    start(onResult) {
      if (listening) return
      const r = new Ctor()
      r.lang = navigator.language || 'en-US'
      r.interimResults = true
      r.continuous = false
      r.maxAlternatives = 1
      r.onresult = (e) => {
        const last = e.results[e.results.length - 1]
        if (last) onResult(last[0]?.transcript ?? '', last.isFinal)
      }
      r.onend = () => {
        listening = false
      }
      r.onerror = () => {
        listening = false
      }
      rec = r
      listening = true
      try {
        r.start()
      } catch {
        listening = false
      }
    },
    stop() {
      try {
        rec?.stop()
      } catch {
        // already stopped
      }
      listening = false
    }
  }
}
