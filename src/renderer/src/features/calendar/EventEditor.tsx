import { useMemo, useState } from 'react'
import { DateTime } from 'luxon'
import type { EditScope, EventPatch, OccurrenceDto, RecurrenceInput } from '@shared/types'
import { describeRecurrence } from '@shared/recurrence/build'
import { useCalendars, useEventDetail, useEventMutations, usePeople, useSettings } from '../../api/hooks'
import { useUi, ZONE, type EditorState } from '../../stores/uiStore'
import { BigButton, Dialog, FieldLabel, Sheet, Toggle } from '../../components/ui'
import { OskInput } from '../../components/Osk'
import { DateField, TimeField } from '../../components/DateTimePickers'
import { textOn } from '../../lib/format'
import { Avatar } from '../../components/Avatar'
import { useWeekStartsOn } from './useCalendarData'

const WEEKDAY_SHORT = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

interface FormState {
  title: string
  calendarId: string
  personIds: string[]
  allDay: boolean
  date: string
  endDate: string
  startMin: number
  endMin: number
  location: string
  recurrence: RecurrenceInput | null
}

function occurrenceToForm(occ: OccurrenceDto, location: string, recurrence: RecurrenceInput | null): FormState {
  const start = DateTime.fromISO(occ.start, { zone: 'utc' }).setZone(ZONE)
  const end = DateTime.fromISO(occ.end, { zone: 'utc' }).setZone(ZONE)
  const lastDay = end > start ? end.minus({ milliseconds: 1 }) : end
  return {
    title: occ.title,
    calendarId: occ.calendarId,
    personIds: occ.personIds,
    allDay: occ.allDay,
    date: start.toISODate()!,
    endDate: lastDay.toISODate()!,
    startMin: start.hour * 60 + start.minute,
    endMin: occ.allDay ? 600 : Math.max(end.hour * 60 + end.minute, 15),
    location,
    recurrence
  }
}

function formTimes(form: FormState): { start: string; end: string } {
  const day = DateTime.fromISO(form.date, { zone: ZONE })
  if (form.allDay) {
    const start = day.startOf('day')
    const endDay = DateTime.fromISO(form.endDate < form.date ? form.date : form.endDate, { zone: ZONE })
    return { start: start.toUTC().toISO()!, end: endDay.plus({ days: 1 }).startOf('day').toUTC().toISO()! }
  }
  const start = day.startOf('day').plus({ minutes: form.startMin })
  const end = day.startOf('day').plus({ minutes: form.endMin })
  return { start: start.toUTC().toISO()!, end: end.toUTC().toISO()! }
}

export function EventEditor() {
  const editor = useUi((s) => s.editor)
  const closeEditor = useUi((s) => s.closeEditor)
  if (editor.mode === 'closed') return null
  const key = editor.mode === 'create' ? `create-${editor.date}` : `edit-${editor.occurrence.key}`
  return <EditorSheet key={key} editor={editor} onClose={closeEditor} />
}

function EditorSheet({ editor, onClose }: { editor: Exclude<EditorState, { mode: 'closed' }>; onClose: () => void }) {
  const { data: people = [] } = usePeople()
  const { data: calendars = [] } = useCalendars()
  const { data: settings } = useSettings()
  const weekStartsOn = useWeekStartsOn()
  const timeFormat = settings?.timeFormat ?? '12h'
  const mutations = useEventMutations()

  const occ = editor.mode === 'edit' ? editor.occurrence : null
  const { data: detail } = useEventDetail(occ?.eventId ?? null)
  const writableCalendars = calendars.filter((c) => !c.readOnly)

  const initial: FormState | null = useMemo(() => {
    if (editor.mode === 'create') {
      if (writableCalendars.length === 0) return null
      return {
        title: '',
        calendarId: writableCalendars[0].id,
        personIds: [],
        allDay: false,
        date: editor.date,
        endDate: editor.date,
        startMin: 9 * 60,
        endMin: 10 * 60,
        location: '',
        recurrence: null
      }
    }
    if (!detail) return null
    return occurrenceToForm(occ!, detail.location ?? '', occ!.eventId === occ!.masterId ? detail.recurrence : null)
    // For exception rows the recurrence lives on the master; editing one occurrence never edits the rule.
  }, [editor, detail, occ, writableCalendars])

  const [form, setForm] = useState<FormState | null>(null)
  const [scopeAsk, setScopeAsk] = useState<'save' | 'delete' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const state = form ?? initial

  if (!state) {
    return <Sheet open onClose={onClose} title={editor.mode === 'create' ? 'New event' : 'Edit event'} children={<div className="h-40" />} />
  }
  const patch = (p: Partial<FormState>): void => setForm({ ...state, ...p })

  const isRecurringSeries = occ?.isRecurring ?? false
  const recurrenceChanged = JSON.stringify(state.recurrence) !== JSON.stringify(initial?.recurrence ?? null)
  const valid = state.title.trim().length > 0 && (state.allDay || state.endMin > state.startMin)

  const buildChanges = (): EventPatch => {
    const changes: EventPatch = {}
    if (!initial) return changes
    if (state.title !== initial.title) changes.title = state.title.trim()
    if (state.location !== initial.location) changes.location = state.location.trim() || null
    if (JSON.stringify([...state.personIds].sort()) !== JSON.stringify([...initial.personIds].sort()))
      changes.personIds = state.personIds
    const timesChanged =
      state.allDay !== initial.allDay ||
      state.date !== initial.date ||
      state.endDate !== initial.endDate ||
      state.startMin !== initial.startMin ||
      state.endMin !== initial.endMin
    if (timesChanged) {
      const t = formTimes(state)
      changes.start = t.start
      changes.end = t.end
      changes.allDay = state.allDay
      changes.tz = ZONE
    }
    if (recurrenceChanged) changes.recurrence = state.recurrence
    return changes
  }

  const save = (scope: EditScope = 'all'): void => {
    if (editor.mode === 'create') {
      const t = formTimes(state)
      mutations.create.mutate(
        {
          calendarId: state.calendarId,
          title: state.title.trim(),
          location: state.location.trim() || null,
          start: t.start,
          end: t.end,
          tz: ZONE,
          allDay: state.allDay,
          personIds: state.personIds,
          recurrence: state.recurrence
        },
        { onSuccess: onClose }
      )
      return
    }
    const changes = buildChanges()
    if (Object.keys(changes).length === 0) {
      onClose()
      return
    }
    mutations.update.mutate(
      {
        id: scope === 'this' ? occ!.eventId : occ!.masterId,
        scope,
        occurrenceStart: occ!.occurrenceStart,
        changes
      },
      { onSuccess: onClose }
    )
  }

  const doDelete = (scope: EditScope = 'all'): void => {
    mutations.remove.mutate(
      {
        id: scope === 'this' ? occ!.eventId : occ!.masterId,
        scope,
        occurrenceStart: occ!.occurrenceStart
      },
      { onSuccess: onClose }
    )
  }

  const onSaveTap = (): void => {
    if (!valid) return
    if (editor.mode === 'edit' && isRecurringSeries) setScopeAsk('save')
    else save()
  }

  const onDeleteTap = (): void => {
    if (isRecurringSeries) setScopeAsk('delete')
    else setConfirmDelete(true)
  }

  const recurOptions: { value: string; label: string }[] = [
    { value: 'none', label: 'Never' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
    { value: 'yearly', label: 'Yearly' }
  ]

  return (
    <Sheet open onClose={onClose} title={editor.mode === 'create' ? 'New event' : 'Edit event'} wide>
      <div className="flex flex-col gap-5 pb-2">
        <OskInput
          value={state.title}
          onChange={(title) => patch({ title })}
          placeholder="What's happening?"
          autoFocus={editor.mode === 'create'}
        />

        {people.length > 0 && (
          <div>
            <FieldLabel>Who</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {people.map((p) => {
                const on = state.personIds.includes(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() =>
                      patch({
                        personIds: on ? state.personIds.filter((id) => id !== p.id) : [...state.personIds, p.id]
                      })
                    }
                    className={`pressable flex min-h-12 items-center gap-2 rounded-full border-2 py-1 pr-4 pl-1.5 text-base font-bold transition-colors ${
                      on ? 'border-transparent text-white' : 'border-line bg-card text-ink-soft'
                    }`}
                    style={on ? { backgroundColor: p.color, color: textOn(p.color) } : undefined}
                  >
                    <span
                      className={`flex h-9 w-9 items-center justify-center overflow-hidden rounded-full text-sm font-extrabold ${on ? 'bg-white/30' : ''}`}
                      style={{ backgroundColor: on ? undefined : p.color, color: on ? 'inherit' : textOn(p.color) }}
                    >
                      <Avatar person={p} className="h-9 w-9 rounded-full text-[0px]" textClassName="text-sm" />
                    </span>
                    {p.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
          <DateField label={state.allDay ? 'First day' : 'Date'} value={state.date} weekStartsOn={weekStartsOn} onChange={(date) => patch({ date, endDate: state.endDate < date ? date : state.endDate })} />
          <div className="flex items-end gap-3 pb-1">
            <div>
              <FieldLabel>All day</FieldLabel>
              <Toggle checked={state.allDay} onChange={(allDay) => patch({ allDay })} label="All day" />
            </div>
          </div>
        </div>

        {state.allDay ? (
          <DateField label="Last day" value={state.endDate} weekStartsOn={weekStartsOn} onChange={(endDate) => patch({ endDate })} />
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <TimeField
              label="Starts"
              minutes={state.startMin}
              timeFormat={timeFormat}
              onChange={(startMin) => {
                const duration = state.endMin - state.startMin
                patch({ startMin, endMin: Math.min(startMin + Math.max(duration, 15), 24 * 60 - 5) })
              }}
            />
            <TimeField label="Ends" minutes={state.endMin} timeFormat={timeFormat} onChange={(endMin) => patch({ endMin })} />
          </div>
        )}

        <div>
          <FieldLabel>Repeats</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            {recurOptions.map((opt) => {
              const on = (state.recurrence?.freq ?? 'none') === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() =>
                    patch({
                      recurrence:
                        opt.value === 'none'
                          ? null
                          : {
                              freq: opt.value as RecurrenceInput['freq'],
                              ...(opt.value === 'weekly'
                                ? { byWeekdays: [DateTime.fromISO(state.date, { zone: ZONE }).weekday - 1] }
                                : {})
                            }
                    })
                  }
                  className={`pressable min-h-12 rounded-full px-5 text-base font-bold ${
                    on ? 'bg-ink text-paper' : 'border-2 border-line bg-card text-ink-soft'
                  }`}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
          {state.recurrence?.freq === 'weekly' && (
            <div className="mt-3 flex gap-2">
              {WEEKDAY_SHORT.map((label, i) => {
                const on = state.recurrence?.byWeekdays?.includes(i) ?? false
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      const cur = state.recurrence?.byWeekdays ?? []
                      const next = on ? cur.filter((d) => d !== i) : [...cur, i]
                      patch({ recurrence: { ...state.recurrence!, byWeekdays: next.length > 0 ? next : [i] } })
                    }}
                    className={`pressable flex h-12 w-12 items-center justify-center rounded-full text-base font-extrabold ${
                      on ? 'bg-ember text-white' : 'bg-paper-deep text-ink-soft'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}
          {state.recurrence && (
            <div className="mt-3 flex items-center gap-3">
              <span className="text-base font-semibold text-ink-soft">{describeRecurrence(state.recurrence)}</span>
              <button
                type="button"
                onClick={() =>
                  patch({
                    recurrence: {
                      ...state.recurrence!,
                      untilDate: state.recurrence!.untilDate
                        ? undefined
                        : DateTime.fromISO(state.date, { zone: ZONE }).plus({ months: 3 }).toISODate()!
                    }
                  })
                }
                className="pressable rounded-full border-2 border-line bg-card px-4 py-1.5 text-sm font-bold text-ink-soft"
              >
                {state.recurrence.untilDate ? 'Remove end date' : 'Set end date'}
              </button>
            </div>
          )}
          {state.recurrence?.untilDate && (
            <div className="mt-3 max-w-xs">
              <DateField
                label="Repeats until"
                value={state.recurrence.untilDate}
                weekStartsOn={weekStartsOn}
                onChange={(untilDate) => patch({ recurrence: { ...state.recurrence!, untilDate } })}
              />
            </div>
          )}
        </div>

        <OskInput value={state.location} onChange={(location) => patch({ location })} placeholder="Location (optional)" />

        {writableCalendars.length > 1 && (
          <div>
            <FieldLabel>Calendar</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {writableCalendars.map((c) => {
                const on = state.calendarId === c.id
                return (
                  <button
                    key={c.id}
                    type="button"
                    disabled={editor.mode === 'edit'}
                    onClick={() => patch({ calendarId: c.id })}
                    className={`pressable flex min-h-12 items-center gap-2 rounded-full border-2 px-4 text-base font-bold disabled:opacity-50 ${
                      on ? 'border-ink bg-ink text-paper' : 'border-line bg-card text-ink-soft'
                    }`}
                  >
                    <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: c.color }} />
                    {c.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="mt-2 flex items-center gap-3">
          {editor.mode === 'edit' && !occ?.readOnly && (
            <BigButton variant="danger" onClick={onDeleteTap}>
              Delete
            </BigButton>
          )}
          <div className="flex-1" />
          <BigButton variant="ghost" onClick={onClose}>
            Cancel
          </BigButton>
          <BigButton onClick={onSaveTap} disabled={!valid || occ?.readOnly} className="min-w-36">
            Save
          </BigButton>
        </div>
      </div>

      <ScopeDialog
        open={scopeAsk !== null}
        intent={scopeAsk ?? 'save'}
        hideThis={scopeAsk === 'save' && recurrenceChanged}
        onClose={() => setScopeAsk(null)}
        onPick={(scope) => {
          setScopeAsk(null)
          if (scopeAsk === 'save') save(scope)
          else doDelete(scope)
        }}
      />

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this event?">
        <div className="flex flex-col gap-3">
          <BigButton variant="danger" onClick={() => doDelete('all')}>
            Delete event
          </BigButton>
          <BigButton variant="ghost" onClick={() => setConfirmDelete(false)}>
            Keep it
          </BigButton>
        </div>
      </Dialog>
    </Sheet>
  )
}

function ScopeDialog({
  open,
  intent,
  hideThis,
  onClose,
  onPick
}: {
  open: boolean
  intent: 'save' | 'delete'
  hideThis?: boolean
  onClose: () => void
  onPick: (scope: EditScope) => void
}) {
  const verb = intent === 'save' ? 'Change' : 'Delete'
  return (
    <Dialog open={open} onClose={onClose} title={`${verb} a repeating event`}>
      <div className="flex flex-col gap-3">
        {!hideThis && (
          <BigButton variant="ghost" onClick={() => onPick('this')}>
            Just this one
          </BigButton>
        )}
        <BigButton variant="ghost" onClick={() => onPick('following')}>
          This and following
        </BigButton>
        <BigButton variant={intent === 'delete' ? 'danger' : 'primary'} onClick={() => onPick('all')}>
          All events in the series
        </BigButton>
      </div>
    </Dialog>
  )
}
