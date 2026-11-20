import { useState } from 'react'
import { DateTime } from 'luxon'
import type { DayChoreDto, PersonDto } from '@shared/types'
import { partOfDay, type DayPart } from '@shared/daypart'
import { useBalances, useChoreMutations, useChoresDay, usePeople, useSettings } from '../../api/hooks'
import { useUi, ZONE } from '../../stores/uiStore'
import { isToday, textOn } from '../../lib/format'
import { Avatar } from '../../components/Avatar'
import { CheckIcon, CloudSunIcon, MoonIcon, SunIcon } from '../../components/icons'
import { BigButton, SegmentedControl } from '../../components/ui'
import { RewardsDialog } from './RewardsDialog'

function StarBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-sun-soft px-2.5 py-1 text-sm font-extrabold text-ember-deep">
      <span aria-hidden>★</span>
      {count}
    </span>
  )
}

function ChoreRow({
  chore,
  person,
  claimer,
  date,
  canCheck,
  people,
  chooserFor,
  setChooserFor
}: {
  chore: DayChoreDto
  person: PersonDto | null
  claimer: PersonDto | null
  date: string
  canCheck: boolean
  people: PersonDto[]
  chooserFor: string | null
  setChooserFor: (id: string | null) => void
}) {
  const mutations = useChoreMutations()
  const color = person?.color ?? '#8E4EC6'
  const toggle = (): void => {
    if (!canCheck) return
    if (chore.upForGrabs && !chore.completed) {
      setChooserFor(chooserFor === chore.choreId ? null : chore.choreId)
      return
    }
    if (chore.completed) mutations.uncomplete.mutate({ choreId: chore.choreId, date })
    else mutations.complete.mutate({ choreId: chore.choreId, date, personId: person?.id })
  }
  const claiming = chooserFor === chore.choreId
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={!canCheck}
        className={`pressable flex w-full items-center gap-3 rounded-2xl bg-card p-3 text-left shadow-card disabled:opacity-60 ${
          chore.completed ? 'opacity-75' : ''
        }`}
      >
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[3px] transition-colors"
          style={{
            borderColor: color,
            backgroundColor: chore.completed ? color : 'transparent'
          }}
        >
          {chore.completed && <CheckIcon size={24} className="animate-pop" style={{ color: textOn(color) }} />}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-lg font-bold ${chore.completed ? 'text-ink-faint line-through' : ''}`}
        >
          {chore.title}
        </span>
        {chore.upForGrabs && !chore.completed && (
          <span className="shrink-0 rounded-full bg-paper-deep px-2.5 py-1 text-xs font-extrabold text-ink-soft">
            Up for grabs
          </span>
        )}
        {claimer && <Avatar person={claimer} className="h-8 w-8 shrink-0 rounded-full text-xs" />}
        {chore.starsValue > 0 && <StarBadge count={chore.starsValue} />}
      </button>
      {claiming && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-paper-deep/60 p-2">
          <span className="px-1 text-sm font-extrabold text-ink-faint">Who did it?</span>
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-label={`Claim for ${p.name}`}
              onClick={() => {
                mutations.complete.mutate({ choreId: chore.choreId, date, personId: p.id })
                setChooserFor(null)
              }}
              className="pressable flex items-center gap-1.5 rounded-full bg-card py-1 pr-3 pl-1 shadow-card"
            >
              <Avatar person={p} className="h-8 w-8 rounded-full text-xs" />
              <span className="text-sm font-bold">{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const GROUP_META: { key: string; label: string | null; Icon: typeof SunIcon | null; part: DayPart | null }[] = [
  { key: 'morning', label: 'Morning', Icon: SunIcon, part: 'morning' },
  { key: 'afternoon', label: 'Afternoon', Icon: CloudSunIcon, part: 'afternoon' },
  { key: 'anytime', label: null, Icon: null, part: null },
  { key: 'evening', label: 'Evening', Icon: MoonIcon, part: 'evening' }
]

function PersonColumn({
  person,
  chores,
  date,
  canCheck,
  people,
  chooserFor,
  setChooserFor,
  onlyPart
}: {
  person: PersonDto | null
  chores: DayChoreDto[]
  date: string
  canCheck: boolean
  people: PersonDto[]
  chooserFor: string | null
  setChooserFor: (id: string | null) => void
  onlyPart: DayPart | null
}) {
  const { data: balances = [] } = useBalances()
  const balance = person ? (balances.find((b) => b.personId === person.id)?.balance ?? 0) : 0
  const groups = GROUP_META.map((g) => ({
    ...g,
    items: chores.filter((c) => (c.routine ?? 'anytime') === g.key && (onlyPart === null || g.part === null || g.part === onlyPart))
  })).filter((g) => g.items.length > 0)
  const doneCount = chores.filter((c) => c.completed).length

  return (
    <div className="flex min-h-0 w-80 shrink-0 flex-col rounded-card bg-paper-deep/40 p-3">
      <div className="mb-3 flex items-center gap-3">
        {person && <Avatar person={person} className="h-12 w-12 shrink-0 rounded-full text-base" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-bold">{person?.name ?? 'Up for grabs'}</div>
          <div className="text-sm font-bold text-ink-faint">
            {doneCount}/{chores.length} done
          </div>
        </div>
        {person && <StarBadge count={balance} />}
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
            {g.items.map((c) => (
              <ChoreRow
                key={c.choreId}
                chore={c}
                person={person ?? people.find((p) => p.id === c.claimerId) ?? null}
                claimer={c.claimerId ? (people.find((p) => p.id === c.claimerId) ?? null) : null}
                date={date}
                canCheck={canCheck}
                people={people}
                chooserFor={chooserFor}
                setChooserFor={setChooserFor}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function ChoresView() {
  const focusedDate = useUi((s) => s.focusedDate)
  const hiddenPeople = useUi((s) => s.hiddenPeople)
  const setSettingsOpen = useUi((s) => s.setSettingsOpen)
  const { data: people = [] } = usePeople()
  const { data: settings } = useSettings()
  const { data: chores = [] } = useChoresDay(focusedDate)
  const [rewardsOpen, setRewardsOpen] = useState(false)
  const [chooserFor, setChooserFor] = useState<string | null>(null)
  const [mode, setMode] = useState<'all' | 'current'>(settings?.routinesDisplay ?? 'all')
  const day = DateTime.fromISO(focusedDate, { zone: ZONE })
  // checking off chores for other days is allowed only for today and the past
  const canCheck = focusedDate <= DateTime.now().setZone(ZONE).toISODate()!
  const onlyPart = mode === 'current' && isToday(focusedDate) ? partOfDay(DateTime.now().setZone(ZONE)) : null

  const byPerson = new Map<string, DayChoreDto[]>()
  const grabs: DayChoreDto[] = []
  for (const c of chores) {
    if (c.upForGrabs) grabs.push(c)
    else if (c.personId) {
      const arr = byPerson.get(c.personId) ?? []
      arr.push(c)
      byPerson.set(c.personId, arr)
    }
  }
  const columns = people.filter((p) => !hiddenPeople.includes(p.id) && byPerson.has(p.id))
  const showGrabs = grabs.length > 0 && (onlyPart === null || grabs.some((c) => onlyPart === null || c.routine === null || c.routine === onlyPart))

  return (
    <div className="flex h-full flex-col px-6 pb-6">
      <div className="animate-rise mb-4 flex items-end gap-4">
        <div className="flex-1">
          <div className="font-display text-4xl">
            {isToday(focusedDate) ? "Today's chores" : `Chores · ${day.toFormat('cccc, LLL d')}`}
          </div>
        </div>
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v)}
          options={[
            { value: 'all', label: 'All routines' },
            { value: 'current', label: 'Now' }
          ]}
        />
        <BigButton variant="ghost" onClick={() => setRewardsOpen(true)}>
          ★ Rewards
        </BigButton>
      </div>

      {columns.length === 0 && !showGrabs ? (
        <div className="animate-rise mt-16 flex flex-col items-center gap-4 text-center">
          <div className="font-display text-3xl text-ink-faint">No chores for this day</div>
          <p className="max-w-md text-base font-semibold text-ink-soft">
            Parents can set up routines and chores in Settings → Chores.
          </p>
          <BigButton variant="ghost" onClick={() => setSettingsOpen(true)}>
            Open settings
          </BigButton>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 justify-center gap-4 overflow-x-auto">
          {showGrabs && (
            <div className="animate-rise flex min-h-0">
              <PersonColumn
                person={null}
                chores={grabs}
                date={focusedDate}
                canCheck={canCheck}
                people={people}
                chooserFor={chooserFor}
                setChooserFor={setChooserFor}
                onlyPart={onlyPart}
              />
            </div>
          )}
          {columns.map((person, i) => (
            <div key={person.id} className="animate-rise flex min-h-0" style={{ animationDelay: `${i * 60}ms` }}>
              <PersonColumn
                person={person}
                chores={byPerson.get(person.id)!}
                date={focusedDate}
                canCheck={canCheck}
                people={people}
                chooserFor={chooserFor}
                setChooserFor={setChooserFor}
                onlyPart={onlyPart}
              />
            </div>
          ))}
        </div>
      )}

      <RewardsDialog open={rewardsOpen} onClose={() => setRewardsOpen(false)} />
    </div>
  )
}
