import { useState } from 'react'
import { DateTime } from 'luxon'
import { MEAL_SLOTS, type MealSlotDto, type MealSlotKind } from '@shared/types'
import { useLists, useMealMutations, useMeals, usePeople, useRecipes } from '../../api/hooks'
import { Dialog, BigButton, FieldLabel } from '../../components/ui'
import { OskInput } from '../../components/Osk'
import { Avatar } from '../../components/Avatar'
import { ZONE } from '../../stores/uiStore'
import { textOn } from '../../lib/format'

export const SLOT_META: Record<MealSlotKind, { letter: string; label: string; color: string }> = {
  breakfast: { letter: 'B', label: 'Breakfast', color: '#FFB224' },
  lunch: { letter: 'L', label: 'Lunch', color: '#46A758' },
  dinner: { letter: 'D', label: 'Dinner', color: '#D95B3A' },
  snack: { letter: 'S', label: 'Snack', color: '#6E56CF' }
}

/** Meals for the days covered by a UTC instant range (as used by calendar views). */
export function useMealsForRange(range: { start: string; end: string }) {
  const startDate = DateTime.fromISO(range.start, { zone: 'utc' }).setZone(ZONE).toISODate()!
  const endDate = DateTime.fromISO(range.end, { zone: 'utc' }).setZone(ZONE).minus({ milliseconds: 1 }).toISODate()!
  const { data } = useMeals(startDate, endDate)
  const byDay = new Map<string, MealSlotDto[]>()
  for (const m of data ?? []) {
    const arr = byDay.get(m.date) ?? []
    arr.push(m)
    byDay.set(m.date, arr)
  }
  for (const arr of byDay.values()) {
    arr.sort((a, b) => MEAL_SLOTS.indexOf(a.slot) - MEAL_SLOTS.indexOf(b.slot) || a.sortOrder - b.sortOrder)
  }
  return byDay
}

/** Compact per-day strip shown at the bottom of week columns / day view.
 *  Meal chips are draggable — dropping one on another day moves it there. */
export function MealStrip({
  date,
  meals,
  onOpen,
  onMove,
  compact = true
}: {
  date: string
  meals: MealSlotDto[]
  onOpen: (date: string) => void
  onMove?: (mealId: string, date: string, slot: MealSlotKind) => void
  compact?: boolean
}) {
  const { data: people = [] } = usePeople()
  const [over, setOver] = useState(false)
  return (
    <button
      type="button"
      onClick={() => onOpen(date)}
      onDragOver={(e) => {
        if (onMove) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (!onMove) return
        e.preventDefault()
        e.stopPropagation()
        const mealId = e.dataTransfer.getData('text/osl-meal-id')
        const slot = e.dataTransfer.getData('text/osl-meal-slot') as MealSlotKind
        if (mealId && slot) onMove(mealId, date, slot)
      }}
      className={`pressable w-full rounded-xl border border-dashed px-2 py-1.5 text-left ${
        over ? 'border-ember bg-ember/10' : 'border-line/80 bg-card/50'
      }`}
    >
      {meals.length === 0 ? (
        <span className={`font-bold text-ink-faint ${compact ? 'text-xs' : 'text-sm'}`}>+ Meals</span>
      ) : (
        <span className="flex flex-col gap-0.5">
          {meals.map((m) => (
            <span
              key={m.id}
              draggable={!!onMove}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/osl-meal-id', m.id)
                e.dataTransfer.setData('text/osl-meal-slot', m.slot)
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                onOpen(date)
              }}
              className={`flex cursor-grab items-center gap-1.5 ${compact ? 'text-xs' : 'text-sm'}`}
              title="Drag to another day to move"
            >
              <span
                className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full text-[10px] font-extrabold text-white"
                style={{ backgroundColor: SLOT_META[m.slot].color }}
              >
                {SLOT_META[m.slot].letter}
              </span>
              <span className="truncate font-bold text-ink-soft">{m.text}</span>
              {m.personIds.map((pid) => {
                const p = people.find((x) => x.id === pid)
                return (
                  <span
                    key={pid}
                    className="h-3 w-3 shrink-0 rounded-full ring-1 ring-white/60"
                    style={{ backgroundColor: p?.color ?? '#999' }}
                    title={p?.name}
                  />
                )
              })}
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

interface SlotForm {
  text: string
  recipeId: string | null
  personIds: string[]
}

export function MealsDialog({
  date,
  meals,
  onClose
}: {
  date: string | null
  meals: MealSlotDto[]
  onClose: () => void
}) {
  const mutations = useMealMutations()
  const { data: recipes = [] } = useRecipes()
  const { data: people = [] } = usePeople()
  const { data: lists = [] } = useLists()
  const [values, setValues] = useState<Record<MealSlotKind, SlotForm> | null>(null)
  const [listPick, setListPick] = useState<Record<string, string>>({})
  if (!date) return null

  const original = (slot: MealSlotKind): SlotForm => {
    const m = meals.find((x) => x.slot === slot)
    return { text: m?.text ?? '', recipeId: m?.recipeId ?? null, personIds: m?.personIds ?? [] }
  }
  const current: Record<MealSlotKind, SlotForm> =
    values ?? (Object.fromEntries(MEAL_SLOTS.map((slot) => [slot, original(slot)])) as Record<MealSlotKind, SlotForm>)

  const setSlot = (slot: MealSlotKind, patch: Partial<SlotForm>): void =>
    setValues({ ...current, [slot]: { ...current[slot], ...patch } })

  const save = (): void => {
    for (const slot of MEAL_SLOTS) {
      const before = original(slot)
      const after = current[slot]
      const changed =
        before.text !== after.text ||
        before.recipeId !== after.recipeId ||
        before.personIds.join(',') !== [...after.personIds].sort().join(',')
      if (changed) {
        mutations.set.mutate({
          date,
          slot,
          text: after.text.trim() || null,
          recipeId: after.recipeId,
          personIds: after.personIds
        })
      }
    }
    onClose()
  }

  const groceryLists = lists.filter((l) => l.kind === 'grocery')
  const ingredientLists = groceryLists.length > 0 ? groceryLists : lists

  return (
    <Dialog open onClose={onClose} title={`Meals · ${DateTime.fromISO(date, { zone: ZONE }).toFormat('ccc, LLL d')}`}>
      <div className="flex flex-col gap-3">
        {MEAL_SLOTS.map((slot) => {
          const v = current[slot]
          const recipe = v.recipeId ? recipes.find((r) => r.id === v.recipeId) : null
          return (
            <div key={slot} className="rounded-2xl bg-paper-deep/40 p-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-extrabold text-white"
                  style={{ backgroundColor: SLOT_META[slot].color }}
                >
                  {SLOT_META[slot].letter}
                </span>
                <FieldLabel>{SLOT_META[slot].label}</FieldLabel>
              </div>
              <OskInput
                value={v.text}
                onChange={(t) => setSlot(slot, { text: t })}
                placeholder={`What's for ${slot}?`}
              />
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs font-extrabold text-ink-faint uppercase">Recipe</span>
                <select
                  value={v.recipeId ?? ''}
                  onChange={(e) => setSlot(slot, { recipeId: e.target.value || null })}
                  className="min-h-11 flex-1 rounded-xl bg-card px-2 text-sm font-bold text-ink shadow-card"
                  aria-label={`${SLOT_META[slot].label} recipe`}
                >
                  <option value="">— free text —</option>
                  {recipes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
                </select>
                {recipe && ingredientLists.length > 0 && (
                  <>
                    <select
                      value={listPick[slot] ?? ingredientLists[0].id}
                      onChange={(e) => setListPick({ ...listPick, [slot]: e.target.value })}
                      className="min-h-11 rounded-xl bg-card px-2 text-sm font-bold text-ink-soft shadow-card"
                      aria-label="List for ingredients"
                    >
                      {ingredientLists.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                    <BigButton
                      variant="ghost"
                      onClick={() => {
                        const m = meals.find((x) => x.slot === slot)
                        if (m) mutations.addIngredients.mutate({ mealSlotId: m.id, listId: listPick[slot] ?? ingredientLists[0].id })
                      }}
                    >
                      ＋ ingredients
                    </BigButton>
                  </>
                )}
              </div>
              {people.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {people.map((p) => {
                    const on = v.personIds.includes(p.id)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() =>
                          setSlot(slot, {
                            personIds: on ? v.personIds.filter((id) => id !== p.id) : [...v.personIds, p.id]
                          })
                        }
                        className={`pressable flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-xs font-extrabold ${
                          on ? '' : 'bg-card text-ink-soft shadow-card'
                        }`}
                        style={on ? { backgroundColor: p.color, color: textOn(p.color) } : undefined}
                        title={`Assign to ${p.name}`}
                      >
                        <Avatar person={p} className="h-5 w-5 rounded-full text-[8px]" />
                        {p.name}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
        <div className="mt-1 flex gap-3">
          <div className="flex-1" />
          <BigButton variant="ghost" onClick={onClose}>
            Cancel
          </BigButton>
          <BigButton onClick={save}>Save</BigButton>
        </div>
      </div>
    </Dialog>
  )
}
