import { useEffect, useState } from 'react'
import { DateTime } from 'luxon'
import { usePeople, useSettings } from '../../api/hooks'
import { useUi, ZONE } from '../../stores/uiStore'
import { SegmentedControl, IconButton } from '../../components/ui'
import { ChevronLeftIcon, ChevronRightIcon, GearIcon, PlusIcon } from '../../components/icons'
import { WeatherButton } from '../weather/WeatherHeader'
import { Avatar } from '../../components/Avatar'
import type { CalendarViewKind } from '@shared/types'

function useNow(): DateTime {
  const [now, setNow] = useState(() => DateTime.now().setZone(ZONE))
  useEffect(() => {
    const t = setInterval(() => setNow(DateTime.now().setZone(ZONE)), 20_000)
    return () => clearInterval(t)
  }, [])
  return now
}

function periodLabel(view: CalendarViewKind, focusedDate: string, weekStartsOn: 0 | 1): string {
  const d = DateTime.fromISO(focusedDate, { zone: ZONE })
  if (view === 'home' || view === 'lists') return ''
  if (view === 'day' || view === 'chores') return d.toFormat('LLL d')
  if (view === 'month') return d.toFormat('LLLL yyyy')
  if (view === 'agenda') return `From ${d.toFormat('LLL d')}`
  const target = weekStartsOn === 0 ? 7 : 1
  let start = d
  while (start.weekday !== target) start = start.minus({ days: 1 })
  const end = start.plus({ days: 6 })
  return start.month === end.month
    ? `${start.toFormat('LLL d')} – ${end.toFormat('d')}`
    : `${start.toFormat('LLL d')} – ${end.toFormat('LLL d')}`
}

export function Header() {
  const now = useNow()
  const { data: settings } = useSettings()
  const { data: people = [] } = usePeople()
  const view = useUi((s) => s.view)
  const setView = useUi((s) => s.setView)
  const focusedDate = useUi((s) => s.focusedDate)
  const step = useUi((s) => s.step)
  const goToday = useUi((s) => s.goToday)
  const hiddenPeople = useUi((s) => s.hiddenPeople)
  const togglePerson = useUi((s) => s.togglePerson)
  const setSettingsOpen = useUi((s) => s.setSettingsOpen)
  const weekStartsOn = settings?.weekStartsOn ?? 0
  const timeFormat = settings?.timeFormat ?? '12h'
  return (
    <header className="flex items-center gap-2 px-4 pt-5 pb-4 min-[1500px]:gap-3 min-[1500px]:px-5">
      {/* Today + a big clock (the header is the only clock since the home
          screen dropped its clock tile); scales down so everything still
          fits on 1280-wide displays */}
      <button type="button" onClick={goToday} className="pressable flex shrink-0 items-center gap-3 text-left min-[1500px]:gap-4">
        <div>
          <div className="font-display text-[2.05rem] leading-none font-semibold tracking-tight min-[1500px]:text-[2.6rem]">
            {now.toFormat('cccc')}
          </div>
          <div className="mt-1 text-base font-bold text-ink-soft min-[1500px]:text-lg">{now.toFormat('LLLL d')}</div>
        </div>
        <div className="w-px self-stretch bg-ink-faint/30" />
        <div className="font-display text-[2.05rem] leading-none font-semibold tracking-tight tabular-nums min-[1500px]:text-[3.1rem]">
          {timeFormat === '24h' ? (
            now.toFormat('HH:mm')
          ) : (
            <>
              {now.toFormat('h:mm')}
              <span className="ml-1 text-lg font-bold text-ink-soft min-[1500px]:ml-1.5 min-[1500px]:text-2xl">
                {now.toFormat('a').toLowerCase()}
              </span>
            </>
          )}
        </div>
      </button>

      <WeatherButton />

      <div className="flex-1" />

      {/* person filter: compact avatar circles, never clipped (overlap when the family is large) */}
      {people.length > 0 && (
        <div className={`flex shrink-0 items-center ${people.length >= 4 ? '-space-x-2' : 'gap-1.5'}`}>
          {people.map((p) => {
            const hidden = hiddenPeople.includes(p.id)
            return (
              <button
                key={p.id}
                type="button"
                aria-label={`${hidden ? 'Show' : 'Hide'} ${p.name}`}
                title={p.name}
                onClick={() => togglePerson(p.id)}
                className={`pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full ring-2 ring-paper transition-all ${
                  hidden ? 'opacity-35 grayscale' : 'shadow-card'
                }`}
              >
                <Avatar person={p} className="h-11 w-11 rounded-full text-sm" />
              </button>
            )
          })}
        </div>
      )}

      {/* period nav (removed from layout where it isn't meaningful — space matters here) */}
      {view !== 'lists' && view !== 'home' && (
        <div className="flex shrink-0 items-center gap-1 rounded-2xl bg-paper-deep/70 p-1">
          <IconButton label="Previous" onClick={() => step(-1)}>
            <ChevronLeftIcon />
          </IconButton>
          <button
            type="button"
            onClick={goToday}
            className="pressable min-w-16 rounded-xl px-2 py-2 text-center text-base font-extrabold text-ink min-[1500px]:min-w-24"
          >
            {periodLabel(view, focusedDate, weekStartsOn)}
          </button>
          <IconButton label="Next" onClick={() => step(1)}>
            <ChevronRightIcon />
          </IconButton>
        </div>
      )}

      <SegmentedControl
        value={view}
        onChange={setView}
        options={[
          { value: 'home', label: 'Home' },
          { value: 'day', label: 'Day' },
          { value: 'week', label: 'Week' },
          { value: 'month', label: 'Month' },
          { value: 'agenda', label: 'Agenda' },
          { value: 'chores', label: 'Chores' },
          { value: 'lists', label: 'Lists' }
        ]}
      />

      <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
        <GearIcon size={26} />
      </IconButton>
    </header>
  )
}

export function Fab() {
  const openCreate = useUi((s) => s.openCreate)
  return (
    <button
      type="button"
      aria-label="Add event"
      onClick={() => openCreate()}
      className="pressable fixed right-7 bottom-7 z-30 flex h-18 w-18 items-center justify-center rounded-full bg-ember text-white shadow-float hover:bg-ember-deep"
    >
      <PlusIcon size={32} />
    </button>
  )
}
