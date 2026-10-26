import { create } from 'zustand'
import { DateTime } from 'luxon'
import type { CalendarViewKind, OccurrenceDto } from '@shared/types'

export const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

export type EditorState =
  | { mode: 'closed' }
  | { mode: 'create'; date: string }
  | { mode: 'edit'; occurrence: OccurrenceDto }

interface UiState {
  view: CalendarViewKind
  /** YYYY-MM-DD in the device zone */
  focusedDate: string
  hiddenPeople: string[]
  editor: EditorState
  settingsOpen: boolean

  setView(view: CalendarViewKind): void
  setFocusedDate(date: string): void
  goToday(): void
  step(direction: 1 | -1): void
  togglePerson(id: string): void
  openCreate(date?: string): void
  openEdit(occurrence: OccurrenceDto): void
  closeEditor(): void
  setSettingsOpen(open: boolean): void
}

const today = (): string => DateTime.now().setZone(ZONE).toISODate()!

export const useUi = create<UiState>((set, get) => ({
  view: 'home',
  focusedDate: today(),
  hiddenPeople: [],
  editor: { mode: 'closed' },
  settingsOpen: false,

  setView: (view) => set({ view }),
  setFocusedDate: (focusedDate) => set({ focusedDate }),
  goToday: () => set({ focusedDate: today() }),
  step: (direction) => {
    const { view, focusedDate } = get()
    if (view === 'home' || view === 'lists') return
    const d = DateTime.fromISO(focusedDate, { zone: ZONE })
    const next =
      view === 'day' || view === 'chores' || view === 'habits'
        ? d.plus({ days: direction })
        : view === 'month'
          ? d.plus({ months: direction })
          : d.plus({ weeks: direction })
    set({ focusedDate: next.toISODate()! })
  },
  togglePerson: (id) =>
    set((s) => ({
      hiddenPeople: s.hiddenPeople.includes(id)
        ? s.hiddenPeople.filter((p) => p !== id)
        : [...s.hiddenPeople, id]
    })),
  openCreate: (date) => set({ editor: { mode: 'create', date: date ?? get().focusedDate } }),
  openEdit: (occurrence) => set({ editor: { mode: 'edit', occurrence } }),
  closeEditor: () => set({ editor: { mode: 'closed' } }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen })
}))
