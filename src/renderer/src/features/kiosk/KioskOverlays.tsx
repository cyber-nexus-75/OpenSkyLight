import { useEffect, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import mpegts from 'mpegts.js'
import { ipcInvoke } from '../../api/client'
import { useSettings, usePeople, useOccurrences, useChoresDay, useWeather } from '../../api/hooks'
import { ZONE } from '../../stores/uiStore'
import { useKioskState } from '../../stores/kioskStore'

const WAKE_OVERRIDE_MS = 5 * 60 * 1000
const SLIDE_MS = 12_000

function useClock(): DateTime {
  const [now, setNow] = useState(() => DateTime.now().setZone(ZONE))
  useEffect(() => {
    const t = setInterval(() => setNow(DateTime.now().setZone(ZONE)), 10_000)
    return () => clearInterval(t)
  }, [])
  return now
}

function ScreensaverOverlay({ onDismiss }: { onDismiss: () => void }) {
  const queryClient = useQueryClient()
  const { data: photos = [] } = useQuery({
    queryKey: ['screensaverPhotos'],
    queryFn: () => ipcInvoke('screensaver:listPhotos', undefined),
    staleTime: 60_000
  })
  // photos changed on the server (phone upload / webdav pull) — refresh the list
  useEffect(() => {
    return window.osl.on('push:screensaverPhotos', () => {
      void queryClient.invalidateQueries({ queryKey: ['screensaverPhotos'] })
    })
  }, [queryClient])
  const { data: settings } = useSettings()
  const [index, setIndex] = useState(0)
  const now = useClock()
  const timeFormat = settings?.timeFormat ?? '12h'

  useEffect(() => {
    if (photos.length < 2) return
    const t = setInterval(() => setIndex((i) => (i + 1) % photos.length), SLIDE_MS)
    return () => clearInterval(t)
  }, [photos.length])

  const current = photos.length > 0 ? photos[index % photos.length] : null
  const next = photos.length > 1 ? photos[(index + 1) % photos.length] : null

  return (
    <div className="fixed inset-0 z-[80] cursor-none bg-black" onPointerDown={onDismiss}>
      {current && (
        <img
          key={current}
          src={current}
          alt=""
          className="absolute inset-0 h-full w-full object-contain"
          style={{ animation: 'fade-in 1.2s ease both' }}
        />
      )}
      {/* preload the next slide so the crossfade never flashes */}
      {next && <img src={next} alt="" className="hidden" />}
      <div className="absolute bottom-10 left-12 select-none">
        <div className="font-display text-7xl font-semibold text-white/90 drop-shadow-lg">
          {timeFormat === '24h' ? now.toFormat('HH:mm') : now.toFormat('h:mm')}
        </div>
        <div className="mt-1 text-2xl font-bold text-white/70 drop-shadow-lg">{now.toFormat('cccc, LLLL d')}</div>
      </div>
    </div>
  )
}

function SleepOverlay({ onWake }: { onWake: () => void }) {
  const now = useClock()
  return (
    <div className="fixed inset-0 z-[90] cursor-none bg-black" onPointerDown={onWake}>
      <div className="absolute right-8 bottom-6 text-xl font-semibold text-white/15 select-none">
        {now.toFormat('h:mm a').toLowerCase()}
      </div>
    </div>
  )
}

/**
 * Morning briefing: shown when the display wakes from sleep in the morning —
 * weather, everyone's events in their color, chore counts, birthdays.
 * Dismisses on tap or after 90s.
 */
function BriefingOverlay({ onDismiss }: { onDismiss: () => void }) {
  const todayIso = DateTime.now().toISODate()!
  const { data: weather } = useWeather()
  const { data: people = [] } = usePeople()
  const { data: occurrences = [] } = useOccurrences({ start: `${todayIso}T00:00:00`, end: `${todayIso}T23:59:59` })
  const { data: chores = [] } = useChoresDay(todayIso)
  const now = useClock()

  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 90_000)
    return () => window.clearTimeout(timer)
  }, [onDismiss])

  const todays = occurrences
    .filter((o) => o.start.slice(0, 10) === todayIso)
    .sort((a, b) => a.start.localeCompare(b.start))
  const birthdayPeople = people.filter((p) => p.birthday === now.toFormat('MM-dd'))
  const doneChores = chores.filter((c) => c.completed).length

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-paper p-10 text-ink" onPointerDown={onDismiss}>
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-6xl font-bold">Good morning ☀️</h1>
        <div className="text-right">
          <div className="text-5xl font-extrabold">{now.toFormat('h:mm a').toLowerCase()}</div>
          {weather && (
            <div className="text-2xl font-bold text-ink-soft">
              {weather.temperature}°{weather.unit === 'c' ? 'C' : 'F'} · {weather.label}
            </div>
          )}
        </div>
      </div>

      {birthdayPeople.length > 0 && (
        <div className="mt-6 rounded-card bg-ember/10 p-4 text-2xl font-extrabold text-ember-deep">
          🎂 Happy birthday {birthdayPeople.map((p) => p.name).join(' & ')}!
        </div>
      )}

      <div className="mt-6 min-h-0 flex-1 overflow-y-auto">
        {todays.length === 0 ? (
          <p className="text-3xl font-bold text-ink-faint">Nothing on the calendar today — enjoy it.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {todays.map((o) => {
              const person = people.find((p) => o.personIds.includes(p.id))
              return (
                <div key={o.key} className="flex items-center gap-4">
                  <span className="w-28 shrink-0 text-2xl font-extrabold text-ink-faint">
                    {o.allDay ? 'all day' : DateTime.fromISO(o.start).toFormat('h:mm a').toLowerCase()}
                  </span>
                  <span className="h-8 w-2 shrink-0 rounded-full" style={{ backgroundColor: person?.color ?? '#0091FF' }} />
                  <span className="min-w-0 flex-1 truncate text-3xl font-bold">{o.title}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between text-xl font-bold text-ink-faint">
        <span>
          Chores: {doneChores}/{chores.length} done
        </span>
        <span>Tap to dismiss</span>
      </div>
    </div>
  )
}

/** Mounts the sleep and screensaver layers based on main-process kiosk events. */
export function KioskOverlays() {
  const [screensaver, setScreensaver] = useState(false)
  const [sleeping, setSleeping] = useState(false)
  const [awakeOverride, setAwakeOverride] = useState(false)
  const [ringAt, setRingAt] = useState<string | null>(null)
  const [briefing, setBriefing] = useState(false)
  const overrideTimer = useRef<number | null>(null)
  const setCovered = useKioskState((s) => s.setCovered)

  // let expensive tiles (camera streams) pause while a layer covers them
  const covered = (sleeping && !awakeOverride) || screensaver
  useEffect(() => {
    setCovered(covered)
  }, [covered, setCovered])

  useEffect(() => {
    const offRing = window.osl.on('push:doorbellRing', (d) => {
      setRingAt((d as { at?: string })?.at ?? new Date().toISOString())
      // a ring wakes the screensaver so the door is shown immediately
      setScreensaver(false)
    })
    const offIdle = window.osl.on('push:kioskIdle', (d) => {
      setScreensaver((d as { state?: string })?.state === 'screensaver')
    })
    const offSleep = window.osl.on('push:sleepState', (d) => {
      const isSleeping = Boolean((d as { sleeping?: boolean })?.sleeping)
      setSleeping(isSleeping)
      if (!isSleeping) {
        // waking from an overnight sleep in the morning → show the briefing
        const hour = new Date().getHours()
        if (hour >= 5 && hour < 11) setBriefing(true)
        // window ended naturally — clear any tap-to-wake override
        setAwakeOverride(false)
        if (overrideTimer.current) window.clearTimeout(overrideTimer.current)
      }
    })
    return () => {
      offRing()
      offIdle()
      offSleep()
    }
  }, [])

  if (briefing) return <BriefingOverlay onDismiss={() => setBriefing(false)} />
  if (sleeping && !awakeOverride) {
    return (
      <SleepOverlay
        onWake={() => {
          setAwakeOverride(true)
          if (overrideTimer.current) window.clearTimeout(overrideTimer.current)
          overrideTimer.current = window.setTimeout(() => setAwakeOverride(false), WAKE_OVERRIDE_MS)
        }}
      />
    )
  }
  if (ringAt) return <DoorbellOverlay ringAt={ringAt} onDismiss={() => setRingAt(null)} />
  if (screensaver) return <ScreensaverOverlay onDismiss={() => setScreensaver(false)} />
  return null
}

/** Doorbell ring: chime + live doorbell camera full-screen; auto-dismisses. */
function DoorbellOverlay({ ringAt, onDismiss }: { ringAt: string; onDismiss: () => void }) {
  const { data: status } = useQuery({
    queryKey: ['doorbellStatus'],
    queryFn: () => ipcInvoke('doorbell:getStatus', undefined)
  })
  const cameraId = status?.cameraId ?? null
  const videoRef = useRef<HTMLVideoElement>(null)
  const [dismissedAtRing, setDismissedAtRing] = useState(false)

  // chime — a synthesized bell tone, no asset needed
  useEffect(() => {
    try {
      const ctx = new AudioContext()
      const now = ctx.currentTime
      for (const t of [0, 0.35]) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = 830
        gain.gain.setValueAtTime(0.4, now + t)
        gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.3)
        osc.connect(gain).connect(ctx.destination)
        osc.start(now + t)
        osc.stop(now + t + 0.32)
      }
      const closer = (): void => void ctx.close()
      setTimeout(closer, 1200)
    } catch {
      // audio is best-effort; the visual overlay is the real alert
    }
  }, [ringAt])

  // auto-dismiss after 30s
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 30_000)
    return () => window.clearTimeout(timer)
  }, [ringAt, onDismiss])

  // live camera stream while the overlay is up (same pipeline as camera tiles)
  useEffect(() => {
    const video = videoRef.current
    if (!cameraId || !video || dismissedAtRing) return
    if (typeof mpegts === 'undefined' || !mpegts.isSupported()) return
    let player: mpegts.Player | null = null
    let sessionId: string | null = null
    let stopped = false
    ipcInvoke('camera:start', { cameraId })
      .then((res) => {
        if (stopped) {
          void ipcInvoke('camera:stop', { sessionId: res.sessionId })
          return
        }
        sessionId = res.sessionId
        player = mpegts.createPlayer(
          { type: 'mpegts', isLive: true, url: res.wsUrl },
          { enableStashBuffer: false, liveBufferLatencyChasing: true }
        )
        player.attachMediaElement(video)
        player.load()
        void player.play()?.catch(() => undefined)
      })
      .catch(() => undefined)
    return () => {
      stopped = true
      try {
        player?.destroy()
      } catch {
        // already torn down
      }
      if (sessionId) void ipcInvoke('camera:stop', { sessionId })
    }
  }, [cameraId, ringAt, dismissedAtRing])

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-ink/95 text-paper">
      <div className="flex items-center justify-between px-8 py-6">
        <h1 className="font-display text-4xl font-bold">🔔 Someone's at the door</h1>
        <button
          type="button"
          onClick={() => {
            setDismissedAtRing(true)
            onDismiss()
          }}
          className="pressable rounded-2xl bg-paper/15 px-6 py-3 text-xl font-extrabold"
        >
          Dismiss
        </button>
      </div>
      <div className="min-h-0 flex-1 px-8 pb-8">
        {cameraId ? (
          <video ref={videoRef} className="h-full w-full rounded-card object-contain" autoPlay muted playsInline />
        ) : (
          <div className="flex h-full items-center justify-center text-2xl font-bold text-paper/70">
            No doorbell camera selected — pick one in Settings → Doorbell
          </div>
        )}
      </div>
    </div>
  )
}
