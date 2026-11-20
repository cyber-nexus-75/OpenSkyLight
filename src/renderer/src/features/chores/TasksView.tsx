import { useState } from 'react'
import { DateTime } from 'luxon'
import type { PersonDto, TaskItemDto } from '@shared/types'
import { useChoreMutations, useChoresTasks, usePeople } from '../../api/hooks'
import { useUi, ZONE } from '../../stores/uiStore'
import { isToday, textOn } from '../../lib/format'
import { Avatar } from '../../components/Avatar'
import { CheckIcon } from '../../components/icons'
import { OskInput } from '../../components/Osk'

function TaskRow({
  task,
  person,
  claimer,
  date,
  canCheck,
  people,
  chooserFor,
  setChooserFor
}: {
  task: TaskItemDto
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
    if (!canCheck || !task.dueToday) return
    if (task.upForGrabs && !task.completedToday) {
      setChooserFor(chooserFor === task.choreId ? null : task.choreId)
      return
    }
    if (task.completedToday) mutations.uncomplete.mutate({ choreId: task.choreId, date })
    else mutations.complete.mutate({ choreId: task.choreId, date, personId: person?.id })
  }
  const claiming = chooserFor === task.choreId
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={!canCheck || !task.dueToday}
        className={`pressable flex w-full items-center gap-3 rounded-2xl bg-card p-3 text-left shadow-card disabled:opacity-60 ${
          task.completedToday ? 'opacity-75' : ''
        }`}
      >
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[3px]"
          style={{ borderColor: color, backgroundColor: task.completedToday ? color : 'transparent' }}
        >
          {task.completedToday && <CheckIcon size={24} className="animate-pop" style={{ color: textOn(color) }} />}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-lg font-bold ${task.completedToday ? 'text-ink-faint line-through' : ''}`}
        >
          {task.title}
        </span>
        {task.overdue && !task.completedToday && (
          <span className="shrink-0 rounded-full bg-ember/15 px-2.5 py-1 text-xs font-extrabold text-ember-deep">
            Overdue
          </span>
        )}
        {task.upForGrabs && !task.completedToday && (
          <span className="shrink-0 rounded-full bg-paper-deep px-2.5 py-1 text-xs font-extrabold text-ink-soft">
            Up for grabs
          </span>
        )}
        {task.routine && (
          <span className="shrink-0 rounded-full bg-paper-deep px-2.5 py-1 text-xs font-extrabold text-ink-soft capitalize">
            {task.routine}
          </span>
        )}
        {claimer && <Avatar person={claimer} className="h-8 w-8 shrink-0 rounded-full text-xs" />}
        {task.starsValue > 0 && (
          <span className="shrink-0 text-sm font-extrabold text-ember-deep">★ {task.starsValue}</span>
        )}
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
                mutations.complete.mutate({ choreId: task.choreId, date, personId: p.id })
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

export function TasksView() {
  const focusedDate = useUi((s) => s.focusedDate)
  const hiddenPeople = useUi((s) => s.hiddenPeople)
  const { data: people = [] } = usePeople()
  const { data: tasks = [] } = useChoresTasks(focusedDate)
  const [query, setQuery] = useState('')
  const [chooserFor, setChooserFor] = useState<string | null>(null)
  const day = DateTime.fromISO(focusedDate, { zone: ZONE })
  const canCheck = focusedDate <= DateTime.now().setZone(ZONE).toISODate()!
  const q = query.trim().toLowerCase()
  const visible = tasks.filter(
    (t) => (q === '' || t.title.toLowerCase().includes(q)) && (t.personId === null || !hiddenPeople.includes(t.personId))
  )
  const grabs = visible.filter((t) => t.upForGrabs)
  const byPerson = new Map<string, TaskItemDto[]>()
  for (const t of visible) {
    if (t.upForGrabs || !t.personId) continue
    const arr = byPerson.get(t.personId) ?? []
    arr.push(t)
    byPerson.set(t.personId, arr)
  }
  const columns = people.filter((p) => byPerson.has(p.id))
  const empty = visible.length === 0

  return (
    <div className="flex h-full flex-col px-6 pb-6">
      <div className="animate-rise mb-4 flex items-end gap-4">
        <div className="flex-1">
          <div className="font-display text-4xl">
            {isToday(focusedDate) ? "All tasks" : `Tasks · ${day.toFormat('cccc, LLL d')}`}
          </div>
        </div>
        <div className="w-72">
          <OskInput value={query} onChange={setQuery} placeholder="Search tasks…" />
        </div>
      </div>

      {empty ? (
        <div className="animate-rise mt-16 flex flex-col items-center gap-4 text-center">
          <div className="font-display text-3xl text-ink-faint">{q ? 'No matching tasks' : 'No chores defined yet'}</div>
          <p className="max-w-md text-base font-semibold text-ink-soft">
            Parents can set up chores in Settings → Chores.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 justify-center gap-4 overflow-x-auto">
          {grabs.length > 0 && (
            <div className="flex min-h-0 w-80 shrink-0 flex-col rounded-card bg-paper-deep/40 p-3">
              <div className="mb-3 px-1 text-sm font-extrabold tracking-wide text-ink-faint uppercase">Up for grabs</div>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                {grabs.map((t) => (
                  <TaskRow
                    key={t.choreId}
                    task={t}
                    person={null}
                    claimer={t.claimerId ? (people.find((p) => p.id === t.claimerId) ?? null) : null}
                    date={focusedDate}
                    canCheck={canCheck}
                    people={people}
                    chooserFor={chooserFor}
                    setChooserFor={setChooserFor}
                  />
                ))}
              </div>
            </div>
          )}
          {columns.map((person, i) => (
            <div key={person.id} className="animate-rise flex min-h-0 w-80 shrink-0" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="flex min-h-0 flex-col rounded-card bg-paper-deep/40 p-3">
                <div className="mb-3 flex items-center gap-3">
                  <Avatar person={person} className="h-10 w-10 shrink-0 rounded-full text-sm" />
                  <div className="truncate text-lg font-bold">{person.name}</div>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                  {byPerson.get(person.id)!.map((t) => (
                    <TaskRow
                      key={t.choreId}
                      task={t}
                      person={person}
                      claimer={null}
                      date={focusedDate}
                      canCheck={canCheck}
                      people={people}
                      chooserFor={chooserFor}
                      setChooserFor={setChooserFor}
                    />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
