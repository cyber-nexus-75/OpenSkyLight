import { useMemo, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import type { AiEventDraft, CalendarDto, EventPatch, OccurrenceDto, RecurrenceInput } from '@shared/types'
import { useAiImport, useCalendars, useEventMutations, useOccurrences, usePeople } from '../api/hooks'
import { uploadPhoto } from '../api/client'
import { Card, EmptyNote, GhostButton, PersonAvatar, PrimaryButton, SectionLabel, TextInput } from '../components/ui'

type ViewMode = 'day' | 'week'

/** Mobile calendar: day/week agenda with full create/edit/delete, including
 * recurrence scopes (this / this-and-following / all) and person assignment.
 * A paired phone is trusted (the pairing QR is PIN-gated on the display). */

function parseTime(hhmm: string): { hour: number; minute: number } {
  const [h, m] = hhmm.split(':').map(Number)
  return { hour: h || 0, minute: m || 0 }
}

function draftFromOccurrence(occ: OccurrenceDto, tz: string): EventDraftShape {
  const start = DateTime.fromISO(occ.start).setZone(tz)
  const end = DateTime.fromISO(occ.end).setZone(tz)
  return {
    calendarId: occ.calendarId,
    title: occ.title,
    location: occ.location ?? '',
    date: start.toISODate()!,
    startTime: start.toFormat('HH:mm'),
    endTime: end.toFormat('HH:mm'),
    allDay: occ.allDay,
    personIds: [...occ.personIds],
    repeat: 'once'
  }
}

interface EventDraftShape {
  calendarId: string
  title: string
  location: string
  date: string
  startTime: string
  endTime: string
  allDay: boolean
  personIds: string[]
  repeat: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly'
}

const REPEATS: { value: EventDraftShape['repeat']; label: string; freq: RecurrenceInput['freq'] | null }[] = [
  { value: 'once', label: 'Once', freq: null },
  { value: 'daily', label: 'Daily', freq: 'daily' },
  { value: 'weekly', label: 'Weekly', freq: 'weekly' },
  { value: 'monthly', label: 'Monthly', freq: 'monthly' },
  { value: 'yearly', label: 'Yearly', freq: 'yearly' }
]

export function CalendarPage() {
  const [mode, setMode] = useState<ViewMode>('week')
  const [anchor, setAnchor] = useState(() => DateTime.now().startOf('day'))
  const [editing, setEditing] = useState<{ occ: OccurrenceDto | null; draft: EventDraftShape } | null>(null)
  const [photoState, setPhotoState] = useState<string | null>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiNote, setAiNote] = useState<string | null>(null)
  const tz = DateTime.local().zoneName ?? 'UTC'

  const range = useMemo(() => {
    if (mode === 'day') return { start: anchor, end: anchor.endOf('day') }
    const start = anchor.startOf('week')
    return { start, end: start.plus({ days: 7 }).minus({ milliseconds: 1 }) }
  }, [mode, anchor])
  const { data: occurrences = [], isPending } = useOccurrences(range.start.toISO()!, range.end.toISO()!)
  const { data: people = [] } = usePeople()
  const { data: calendars = [] } = useCalendars()
  const mutations = useEventMutations()

  const byDay = new Map<string, OccurrenceDto[]>()
  for (const occ of occurrences) {
    const day = DateTime.fromISO(occ.start).setZone(tz).toISODate()!
    byDay.set(day, [...(byDay.get(day) ?? []), occ])
  }
  const days = [...byDay.keys()].sort()

  const startNew = (): void => {
    const writable = calendars.filter((c) => !c.readOnly)
    if (writable.length === 0) return
    const now = DateTime.now().setZone(tz)
    setEditing({
      occ: null,
      draft: {
        calendarId: writable[0].id,
        title: '',
        location: '',
        date: now.toISODate()!,
        startTime: now.plus({ hours: 1 }).startOf('hour').toFormat('HH:mm'),
        endTime: now.plus({ hours: 2 }).startOf('hour').toFormat('HH:mm'),
        allDay: false,
        personIds: [],
        repeat: 'once'
      }
    })
  }

  const sendPhoto = async (name: string, file: File): Promise<void> => {
    setPhotoState('Uploading…')
    try {
      await uploadPhoto(name, new Uint8Array(await file.arrayBuffer()))
      setPhotoState('Added to the screensaver ✓')
    } catch (err) {
      setPhotoState(err instanceof Error ? err.message : 'Upload failed')
    }
    setTimeout(() => setPhotoState(null), 4000)
  }

  const confirmAiDraft = (draft: AiEventDraft): void => {
    const writable = calendars.filter((c) => !c.readOnly)
    const cal = writable[0]
    if (!cal) {
      setAiNote('No writable calendar')
      return
    }
    const zone = DateTime.local().zoneName ?? 'UTC'
    const startDate = DateTime.fromISO(draft.date, { zone })
    const startIso = draft.allDay
      ? startDate.toUTC().toISO()
      : startDate.set({ hour: Number(draft.startTime?.slice(0, 2) ?? 9), minute: Number(draft.startTime?.slice(3) ?? 0) }).toUTC().toISO()
    const endIso = draft.allDay
      ? startDate.plus({ days: 1 }).toUTC().toISO()
      : draft.endTime
        ? startDate.set({ hour: Number(draft.endTime.slice(0, 2)), minute: Number(draft.endTime.slice(3)) }).toUTC().toISO()
        : startDate.plus({ hours: 1 }).toUTC().toISO()
    mutations.create.mutate(
      {
        calendarId: cal.id,
        title: draft.title,
        location: draft.location,
        description: draft.description,
        start: startIso!,
        end: endIso!,
        tz: zone,
        allDay: draft.allDay,
        personIds: [],
        recurrence: draft.repeat ? { freq: draft.repeat } : null
      },
      {
        onSuccess: () => {
          setAiNote(`Added "${draft.title}"`)
          setTimeout(() => setAiNote(null), 4000)
        }
      }
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* view switch + navigation */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setAnchor(anchor.minus(mode === 'day' ? { days: 1 } : { weeks: 1 }))}
          className="pressable rounded-xl bg-paper-deep px-3 py-2 font-extrabold text-ink-soft"
          aria-label="Previous"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={() => setAnchor(DateTime.now().startOf('day'))}
          className="pressable rounded-xl bg-paper-deep px-3 py-2 text-sm font-extrabold text-ink-soft"
        >
          Today
        </button>
        <button
          type="button"
          onClick={() => setAnchor(anchor.plus(mode === 'day' ? { days: 1 } : { weeks: 1 }))}
          className="pressable rounded-xl bg-paper-deep px-3 py-2 font-extrabold text-ink-soft"
          aria-label="Next"
        >
          ›
        </button>
        <span className="flex-1 truncate text-right font-display text-lg font-semibold">
          {mode === 'day'
            ? anchor.toFormat('cccc, LLL d')
            : `${range.start.toFormat('LLL d')} – ${range.end.toFormat('LLL d')}`}
        </span>
      </div>
      <div className="flex gap-2">
        {(['day', 'week'] as ViewMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`pressable flex-1 rounded-xl py-2 text-sm font-extrabold ${
              mode === m ? 'bg-ember text-white' : 'bg-paper-deep text-ink-soft'
            }`}
          >
            {m === 'day' ? 'Day' : 'Week'}
          </button>
        ))}
      </div>

      {isPending && <EmptyNote>Loading…</EmptyNote>}
      {!isPending && days.length === 0 && <EmptyNote>Nothing on the calendar.</EmptyNote>}

      {days.map((day) => {
        const d = DateTime.fromISO(day)
        const isToday = day === DateTime.now().toISODate()
        return (
          <Card key={day}>
            <h2 className="mb-1 font-display text-xl font-semibold">
              {isToday ? 'Today' : d.toFormat('cccc')}
              <span className="ml-2 text-base font-bold text-ink-faint">{d.toFormat('LLL d')}</span>
            </h2>
            {byDay
              .get(day)!
              .sort((a, b) => a.start.localeCompare(b.start))
              .map((occ) => (
                <button
                  key={occ.key}
                  type="button"
                  onClick={() => setEditing({ occ, draft: draftFromOccurrence(occ, tz) })}
                  className="flex w-full items-center gap-3 border-b border-line/60 py-2 text-left last:border-0"
                >
                  <span className="w-16 shrink-0 text-sm font-extrabold text-ink-faint">
                    {occ.allDay ? 'All day' : DateTime.fromISO(occ.start).setZone(tz).toFormat('h:mm a').toLowerCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-base font-semibold">
                    {occ.title}
                    {occ.isRecurring && <span className="ml-1 text-ink-faint">↻</span>}
                    {occ.readOnly && <span className="ml-1 text-xs font-extrabold text-ink-faint">RO</span>}
                  </span>
                  <span className="flex shrink-0 -space-x-1.5">
                    {occ.personIds
                      .map((id) => people.find((p) => p.id === id))
                      .filter((p) => p !== undefined)
                      .map((p) => (
                        <PersonAvatar key={p.id} name={p.name} color={p.color} avatarUrl={p.avatarUrl} size="sm" />
                      ))}
                  </span>
                </button>
              ))}
          </Card>
        )
      })}

      <div className="flex flex-wrap gap-2">
        <PrimaryButton onClick={startNew} disabled={calendars.filter((c) => !c.readOnly).length === 0}>
          + New event
        </PrimaryButton>
        <GhostButton onClick={() => setAiOpen(true)}>✨ AI import</GhostButton>
        <GhostButton onClick={() => photoInputRef.current?.click()}>📷 Photo</GhostButton>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void sendPhoto(file.name, file)
          }}
        />
      </div>
      {photoState && <EmptyNote>{photoState}</EmptyNote>}

      {aiOpen && (
        <AiImportSheet
          onClose={() => setAiOpen(false)}
          onConfirm={(draft) => confirmAiDraft(draft)}
        />
      )}
      {aiNote && <EmptyNote>{aiNote}</EmptyNote>}

      {editing && (
        <EventEditor
          calendars={calendars}
          people={people}
          editing={editing}
          onClose={() => setEditing(null)}
          onSave={(scope, draft) => {
            const { occ } = editing
            const recurrence = REPEATS.find((r) => r.value === draft.repeat)!.freq
            const zone = DateTime.local().zoneName ?? 'UTC'
            const startDate = DateTime.fromISO(draft.date, { zone })
            const startIso = draft.allDay
              ? startDate.toUTC().toISO()
              : startDate.set(parseTime(draft.startTime)).toUTC().toISO()
            const endIso = draft.allDay
              ? startDate.plus({ days: 1 }).toUTC().toISO()
              : startDate.set(parseTime(draft.endTime)).toUTC().toISO()
            if (occ) {
              const changes: EventPatch = {
                title: draft.title,
                location: draft.location || null,
                allDay: draft.allDay,
                personIds: draft.personIds
              }
              if (!draft.allDay) {
                changes.start = startIso!
                changes.end = endIso!
                changes.tz = zone
              }
              if (!occ.isRecurring) {
                changes.recurrence = draft.repeat === 'once' ? null : { freq: recurrence! }
              } else if (scope === 'all' && draft.repeat !== 'once') {
                changes.recurrence = { freq: recurrence! }
              }
              mutations.update.mutate(
                {
                  id: occ.eventId,
                  scope: occ.isRecurring ? scope : 'all',
                  occurrenceStart: occ.occurrenceStart,
                  changes
                },
                { onSuccess: () => setEditing(null) }
              )
            } else {
              mutations.create.mutate(
                {
                  calendarId: draft.calendarId,
                  title: draft.title,
                  location: draft.location || null,
                  start: startIso!,
                  end: endIso!,
                  tz: zone,
                  allDay: draft.allDay,
                  personIds: draft.personIds,
                  recurrence: recurrence ? { freq: recurrence } : null
                },
                { onSuccess: () => setEditing(null) }
              )
            }
          }}
          onDelete={(scope) => {
            const { occ } = editing
            if (!occ) return
            mutations.remove.mutate(
              {
                id: occ.eventId,
                scope: occ.isRecurring ? scope : 'all',
                occurrenceStart: occ.occurrenceStart
              },
              { onSuccess: () => setEditing(null) }
            )
          }}
        />
      )}
    </div>
  )
}

function EventEditor({
  calendars,
  people,
  editing,
  onClose,
  onSave,
  onDelete
}: {
  calendars: CalendarDto[]
  people: { id: string; name: string; color: string; avatarUrl: string | null }[]
  editing: { occ: OccurrenceDto | null; draft: EventDraftShape }
  onClose: () => void
  onSave: (scope: 'this' | 'following' | 'all', draft: EventDraftShape) => void
  onDelete: (scope: 'this' | 'following' | 'all') => void
}) {
  const { occ } = editing
  const [scope, setScope] = useState<'this' | 'following' | 'all'>('this')
  const [showDelete, setShowDelete] = useState(false)
  // the draft lives in real state — mutating a shared object would not re-render
  const [draft, setDraft] = useState<EventDraftShape>(editing.draft)
  const patch = (p: Partial<EventDraftShape>): void => {
    setDraft((d) => ({ ...d, ...p }))
  }
  const writable = calendars.filter((c) => !c.readOnly)
  const isRecurring = occ?.isRecurring ?? false
  const readOnly = occ ? !writable.some((c) => c.id === occ.calendarId) : false

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3" onClick={onClose}>
      <Card className="w-full max-w-lg" >
        <div onClick={(e) => e.stopPropagation()}>
          <SectionLabel>{occ ? (readOnly ? 'Event (read-only)' : 'Edit event') : 'New event'}</SectionLabel>
          <div className="flex flex-col gap-3">
            <TextInput
              value={draft.title}
              onChange={(title) => patch({ title })}
              placeholder="What's happening?"
            />
            <TextInput
              value={draft.location}
              onChange={(location) => patch({ location })}
              placeholder="Where (optional)"
            />
            <div className="flex items-center gap-2">
              <label className="flex-1">
                <span className="mb-1 block text-xs font-extrabold text-ink-faint">DATE</span>
                <input
                  type="date"
                  value={draft.date}
                  onChange={(e) => patch({ date: e.target.value })}
                  className="min-h-11 w-full rounded-xl border border-line bg-paper px-3 text-base font-semibold"
                />
              </label>
              {!draft.allDay && (
                <>
                  <label className="flex-1">
                    <span className="mb-1 block text-xs font-extrabold text-ink-faint">START</span>
                    <input
                      type="time"
                      value={draft.startTime}
                      onChange={(e) => patch({ startTime: e.target.value })}
                      className="min-h-11 w-full rounded-xl border border-line bg-paper px-3 text-base font-semibold"
                    />
                  </label>
                  <label className="flex-1">
                    <span className="mb-1 block text-xs font-extrabold text-ink-faint">END</span>
                    <input
                      type="time"
                      value={draft.endTime}
                      onChange={(e) => patch({ endTime: e.target.value })}
                      className="min-h-11 w-full rounded-xl border border-line bg-paper px-3 text-base font-semibold"
                    />
                  </label>
                </>
              )}
            </div>
            <label className="flex items-center gap-2 py-1 text-base font-semibold">
              <input
                type="checkbox"
                checked={draft.allDay}
                onChange={(e) => patch({ allDay: e.target.checked })}
                className="h-5 w-5 accent-[var(--color-ember)]"
              />
              All day
            </label>

            {/* calendar picker */}
            {!readOnly && (
              <div>
                <span className="mb-1 block text-xs font-extrabold text-ink-faint">CALENDAR</span>
                <select
                  value={draft.calendarId}
                  onChange={(e) => patch({ calendarId: e.target.value })}
                  className="min-h-11 w-full rounded-xl border border-line bg-paper px-3 text-base font-semibold"
                >
                  {(occ ? writable.filter((c) => c.id === occ.calendarId || true) : writable).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* person assignment */}
            <div>
              <span className="mb-1 block text-xs font-extrabold text-ink-faint">WHO</span>
              <div className="flex flex-wrap gap-2">
                {people.map((p) => {
                  const on = draft.personIds.includes(p.id)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        patch({
                          personIds: on
                            ? draft.personIds.filter((id) => id !== p.id)
                            : [...draft.personIds, p.id]
                        })
                      }
                      className={`pressable flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1 text-sm font-bold ${
                        on ? 'text-white' : 'bg-paper-deep text-ink-soft'
                      }`}
                      style={on ? { backgroundColor: p.color } : undefined}
                      aria-pressed={on}
                    >
                      <PersonAvatar name={p.name} color={p.color} avatarUrl={p.avatarUrl} size="sm" />
                      {p.name}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* recurrence */}
            {!readOnly && (!isRecurring || scope === 'all') && (
              <div>
                <span className="mb-1 block text-xs font-extrabold text-ink-faint">REPEAT</span>
                <div className="flex flex-wrap gap-2">
                  {REPEATS.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => patch({ repeat: r.value })}
                      className={`pressable rounded-xl px-3 py-2 text-sm font-extrabold ${
                        draft.repeat === r.value ? 'bg-ember text-white' : 'bg-paper-deep text-ink-soft'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* recurrence scope for existing recurring events */}
            {isRecurring && !readOnly && (
              <div>
                <span className="mb-1 block text-xs font-extrabold text-ink-faint">APPLIES TO</span>
                <div className="flex flex-wrap gap-2">
                  {(['this', 'following', 'all'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setScope(s)}
                      className={`pressable rounded-xl px-3 py-2 text-sm font-extrabold ${
                        scope === s ? 'bg-ember text-white' : 'bg-paper-deep text-ink-soft'
                      }`}
                    >
                      {s === 'this' ? 'This event' : s === 'following' ? 'This & following' : 'All events'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-1 flex flex-wrap gap-2">
              {occ && !readOnly && (
                <GhostButton onClick={() => setShowDelete(true)}>Delete</GhostButton>
              )}
              <span className="flex-1" />
              <GhostButton onClick={onClose}>Cancel</GhostButton>
              {!readOnly && (
                <PrimaryButton
                  onClick={() => onSave(isRecurring ? scope : 'all', draft)}
                  disabled={!draft.title.trim() || (draft.endTime <= draft.startTime && !draft.allDay)}
                >
                  Save
                </PrimaryButton>
              )}
            </div>

            {showDelete && occ && (
              <div className="flex flex-col gap-2 rounded-xl bg-paper-deep p-3">
                <span className="text-sm font-bold text-ink-soft">
                  {isRecurring ? 'Delete which events?' : 'Delete this event?'}
                </span>
                {isRecurring ? (
                  <div className="flex flex-wrap gap-2">
                    <PrimaryButton onClick={() => onDelete('this')}>This event</PrimaryButton>
                    <PrimaryButton onClick={() => onDelete('following')}>This & following</PrimaryButton>
                    <PrimaryButton onClick={() => onDelete('all')}>All events</PrimaryButton>
                  </div>
                ) : (
                  <PrimaryButton onClick={() => onDelete('all')}>Delete</PrimaryButton>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}


function AiImportSheet({ onClose, onConfirm }: { onClose: () => void; onConfirm: (draft: AiEventDraft) => void }) {
  const ai = useAiImport()
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [drafts, setDrafts] = useState<AiEventDraft[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const attach = async (files: FileList | null): Promise<void> => {
    const list = [...(files ?? [])].slice(0, 5 - images.length)
    const encoded: string[] = []
    for (const f of list) {
      const buf = await f.arrayBuffer()
      let bin = ''
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      encoded.push(btoa(bin))
    }
    setImages((prev) => [...prev, ...encoded].slice(0, 5))
  }

  const run = (): void => {
    const tz = DateTime.local().zoneName ?? 'UTC'
    ai.mutate(
      { text, images, tz },
      {
        onSuccess: (res) => {
          setError(null)
          setDrafts(res.drafts)
        },
        onError: (err: Error) => setError(err.message)
      }
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3" onClick={onClose}>
      <Card className="w-full max-w-lg">
        <div onClick={(e) => e.stopPropagation()} className="flex flex-col gap-3">
          <SectionLabel>AI import — paste text or attach photos</SectionLabel>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste an email or schedule text…"
            className="min-h-24 w-full rounded-xl border border-line bg-paper p-3 text-base font-semibold outline-none placeholder:text-ink-faint focus:border-ember"
          />
          {error && <p className="text-sm font-bold text-ember-deep">{error}</p>}
          <div className="flex gap-2">
            <GhostButton onClick={() => fileRef.current?.click()} disabled={images.length >= 5}>
              Attach ({images.length}/5)
            </GhostButton>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                void attach(e.target.files)
                e.target.value = ''
              }}
            />
            <span className="flex-1" />
            <PrimaryButton onClick={run} disabled={(!text.trim() && images.length === 0) || ai.isPending}>
              {ai.isPending ? 'Thinking…' : 'Find events'}
            </PrimaryButton>
          </div>
          {drafts !== null && (
            <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
              {drafts.length === 0 && <EmptyNote>No events found.</EmptyNote>}
              {drafts.map((d, i) => (
                <div key={i} className="rounded-xl bg-paper-deep p-3">
                  <div className="font-bold">{d.title}</div>
                  <div className="text-sm font-bold text-ink-faint">
                    {d.date}
                    {d.allDay ? ' · all day' : ` · ${d.startTime ?? ''}–${d.endTime ?? ''}`}
                    {d.repeat ? ` · repeats ${d.repeat}` : ''}
                  </div>
                  {d.note && <div className="mt-1 text-sm font-semibold text-ember-deep">⚠ {d.note}</div>}
                  <div className="mt-2 flex gap-2">
                    <GhostButton onClick={() => setDrafts((prev) => (prev ?? []).filter((x) => x !== d))}>
                      Discard
                    </GhostButton>
                    <span className="flex-1" />
                    <PrimaryButton onClick={() => { onConfirm(d); setDrafts((prev) => (prev ?? []).filter((x) => x !== d)) }}>
                      Add
                    </PrimaryButton>
                  </div>
                </div>
              ))}
              {drafts.length === 0 && <GhostButton onClick={onClose}>Done</GhostButton>}
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
