import { DateTime } from 'luxon'
import type { OccurrenceDto } from '@shared/types'
import { useOccurrences, usePeople } from '../api/hooks'
import { Card, EmptyNote, PersonAvatar } from '../components/ui'

export function AgendaPage() {
  const start = DateTime.now().startOf('day')
  const end = start.plus({ days: 7 }).endOf('day')
  const { data: occurrences = [], isPending } = useOccurrences(start.toISO()!, end.toISO()!)
  const { data: people = [] } = usePeople()

  const byDay = new Map<string, OccurrenceDto[]>()
  for (const occ of occurrences) {
    const day = DateTime.fromISO(occ.start).toISODate()!
    byDay.set(day, [...(byDay.get(day) ?? []), occ])
  }
  const days = [...byDay.keys()].sort()

  return (
    <div className="flex flex-col gap-4">
      {isPending && <EmptyNote>Loading…</EmptyNote>}
      {!isPending && days.length === 0 && <EmptyNote>Nothing on the calendar this week.</EmptyNote>}
      {days.map((day) => {
        const d = DateTime.fromISO(day)
        const isToday = day === start.toISODate()
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
                <div key={occ.key} className="flex items-center gap-3 border-b border-line/60 py-2 last:border-0">
                  <span className="w-16 shrink-0 text-sm font-extrabold text-ink-faint">
                    {occ.allDay ? 'All day' : DateTime.fromISO(occ.start).toFormat('h:mm a').toLowerCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-base font-semibold">{occ.title}</span>
                  <span className="flex shrink-0 -space-x-1.5">
                    {occ.personIds
                      .map((id) => people.find((p) => p.id === id))
                      .filter((p) => p !== undefined)
                      .map((p) => (
                        <PersonAvatar key={p.id} name={p.name} color={p.color} avatarUrl={p.avatarUrl} size="sm" />
                      ))}
                  </span>
                </div>
              ))}
          </Card>
        )
      })}
      <p className="pb-2 text-center text-sm font-semibold text-ink-faint">
        The agenda is read-only here — add and edit events on the display.
      </p>
    </div>
  )
}
