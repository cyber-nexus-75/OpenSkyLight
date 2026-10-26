import { DateTime } from 'luxon'
import type { DayHabitDto, PersonDto } from '@shared/types'
import { useHabitMutations, useHabitsDay, usePeople } from '../../api/hooks'
import { useUi, ZONE } from '../../stores/uiStore'
import { isToday, textOn } from '../../lib/format'
import { Avatar } from '../../components/Avatar'
import { CheckIcon, FlameIcon, MoonIcon, SunIcon } from '../../components/icons'
import { BigButton } from '../../components/ui'

function StreakBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-sun-soft px-2.5 py-1 text-sm font-extrabold text-ember-deep">
      <FlameIcon size={14} />
      {count}
    </span>
  )
}

function HabitRow({
  habit,
  person,
  date,
  canCheck
}: {
  habit: DayHabitDto
  person: PersonDto
  date: string
  canCheck: boolean
}) {
  const mutations = useHabitMutations()
  const toggle = (): void => {
    if (!canCheck) return
    if (habit.completed) mutations.uncomplete.mutate({ habitId: habit.habitId, date })
    else mutations.complete.mutate({ habitId: habit.habitId, date })
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={!canCheck}
      className={`pressable flex w-full items-center gap-3 rounded-2xl bg-card p-3 text-left shadow-card disabled:opacity-60 ${
        habit.completed ? 'opacity-75' : ''
      }`}
    >
      <span
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[3px] transition-colors"
        style={{
          borderColor: person.color,
          backgroundColor: habit.completed ? person.color : 'transparent'
        }}
      >
        {habit.completed && <CheckIcon size={24} className="animate-pop" style={{ color: textOn(person.color) }} />}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-lg font-bold ${habit.completed ? 'text-ink-faint line-through' : ''}`}
      >
        {habit.title}
      </span>
      {habit.streak > 0 && <StreakBadge count={habit.streak} />}
    </button>
  )
}

function PersonColumn({
  person,
  habits,
  date,
  canCheck
}: {
  person: PersonDto
  habits: DayHabitDto[]
  date: string
  canCheck: boolean
}) {
  const groups: { key: string; label: string | null; Icon: typeof SunIcon | null; items: DayHabitDto[] }[] = [
    { key: 'morning', label: 'Morning', Icon: SunIcon, items: habits.filter((h) => h.routine === 'morning') },
    { key: 'anytime', label: null, Icon: null, items: habits.filter((h) => h.routine === null) },
    { key: 'evening', label: 'Evening', Icon: MoonIcon, items: habits.filter((h) => h.routine === 'evening') }
  ].filter((g) => g.items.length > 0)
  const doneCount = habits.filter((h) => h.completed).length
  const bestStreak = habits.reduce((max, h) => Math.max(max, h.streak), 0)

  return (
    <div className="flex min-h-0 w-80 shrink-0 flex-col rounded-card bg-paper-deep/40 p-3">
      <div className="mb-3 flex items-center gap-3">
        <Avatar person={person} className="h-12 w-12 shrink-0 rounded-full text-base" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-bold">{person.name}</div>
          <div className="text-sm font-bold text-ink-faint">
            {doneCount}/{habits.length} done
          </div>
        </div>
        {bestStreak > 0 && <StreakBadge count={bestStreak} />}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.key} className="flex flex-col gap-2">
            {g.label && (
              <div className="mt-1 flex items-center gap-1.5 px-1 text-sm font-extrabold tracking-wide text-ink-faint uppercase">
                {g.Icon && <g.Icon size={15} />}
                {g.label}
              </div>
            )}
            {g.items.map((h) => (
              <HabitRow key={h.habitId} habit={h} person={person} date={date} canCheck={canCheck} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function HabitsView() {
  const focusedDate = useUi((s) => s.focusedDate)
  const hiddenPeople = useUi((s) => s.hiddenPeople)
  const setSettingsOpen = useUi((s) => s.setSettingsOpen)
  const { data: people = [] } = usePeople()
  const { data: habits = [] } = useHabitsDay(focusedDate)
  const day = DateTime.fromISO(focusedDate, { zone: ZONE })
  // checking off habits for other days is allowed only for today and the past
  const canCheck = focusedDate <= DateTime.now().setZone(ZONE).toISODate()!

  const byPerson = new Map<string, DayHabitDto[]>()
  for (const h of habits) {
    const arr = byPerson.get(h.personId) ?? []
    arr.push(h)
    byPerson.set(h.personId, arr)
  }
  const columns = people.filter((p) => !hiddenPeople.includes(p.id) && byPerson.has(p.id))

  return (
    <div className="flex h-full flex-col px-6 pb-6">
      <div className="animate-rise mb-4 flex items-end gap-4">
        <div className="flex-1">
          <div className="font-display text-4xl">
            {isToday(focusedDate) ? "Today's habits" : `Habits · ${day.toFormat('cccc, LLL d')}`}
          </div>
        </div>
      </div>

      {columns.length === 0 ? (
        <div className="animate-rise mt-16 flex flex-col items-center gap-4 text-center">
          <div className="font-display text-3xl text-ink-faint">No habits for this day</div>
          <p className="max-w-md text-base font-semibold text-ink-soft">
            Parents can set up habits in Settings → Habits.
          </p>
          <BigButton variant="ghost" onClick={() => setSettingsOpen(true)}>
            Open settings
          </BigButton>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 justify-center gap-4 overflow-x-auto">
          {columns.map((person, i) => (
            <div key={person.id} className="animate-rise flex min-h-0" style={{ animationDelay: `${i * 60}ms` }}>
              <PersonColumn person={person} habits={byPerson.get(person.id)!} date={focusedDate} canCheck={canCheck} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
