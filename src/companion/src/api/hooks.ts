import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AvatarSetInput,
  ChoreCreateInput,
  ChoreUpdateInput,
  EventCreateInput,
  EventDeleteInput,
  EventUpdateInput
} from '@shared/types'
import { rpc } from './client'

/** Phone tabs get suspended constantly — focus/reconnect refetch is the real
 * freshness mechanism; the 20s interval covers a phone left on the counter. */
const LIVE = { refetchInterval: 20_000, refetchOnWindowFocus: true, refetchOnReconnect: true } as const

export function usePeople() {
  return useQuery({ queryKey: ['people'], queryFn: () => rpc('people:list', undefined), ...LIVE })
}

export function useLists() {
  return useQuery({ queryKey: ['lists'], queryFn: () => rpc('lists:getAll', undefined), ...LIVE })
}

export function useMeals(start: string, end: string) {
  return useQuery({
    queryKey: ['meals', start, end],
    queryFn: () => rpc('meals:getRange', { start, end }),
    ...LIVE
  })
}

export function useChoresDay(date: string) {
  return useQuery({ queryKey: ['choresDay', date], queryFn: () => rpc('chores:getDay', { date }), ...LIVE })
}

export function useChores() {
  return useQuery({ queryKey: ['chores'], queryFn: () => rpc('chores:list', undefined), ...LIVE })
}

export function useBalances() {
  return useQuery({ queryKey: ['balances'], queryFn: () => rpc('stars:balances', undefined), ...LIVE })
}

export function useOccurrences(start: string, end: string) {
  return useQuery({
    queryKey: ['occurrences', start, end],
    queryFn: () => rpc('events:getOccurrences', { start, end }),
    ...LIVE
  })
}

export function useInvalidatingMutation<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
  keys: string[][]
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key })
    }
  })
}

export function useListMutations() {
  const keys = [['lists']]
  return {
    create: useInvalidatingMutation(
      (input: { name: string; color: string; kind: 'grocery' | 'todo' | 'custom' }) => rpc('lists:create', input),
      keys
    ),
    addItem: useInvalidatingMutation((input: { listId: string; text: string }) => rpc('listItems:add', input), keys),
    toggleItem: useInvalidatingMutation((input: { id: string }) => rpc('listItems:toggle', input), keys),
    clearChecked: useInvalidatingMutation((input: { listId: string }) => rpc('listItems:clearChecked', input), keys)
  }
}

export function useMealMutations() {
  return {
    set: useInvalidatingMutation(
      (input: { date: string; slot: 'breakfast' | 'lunch' | 'dinner' | 'snack'; text: string | null }) =>
        rpc('meals:set', input),
      [['meals']]
    )
  }
}

export function useChoreMutations() {
  const keys = [['choresDay'], ['chores'], ['balances']]
  return {
    create: useInvalidatingMutation((input: ChoreCreateInput) => rpc('chores:create', input), keys),
    update: useInvalidatingMutation((input: ChoreUpdateInput) => rpc('chores:update', input), keys),
    complete: useInvalidatingMutation((input: { choreId: string; date: string }) => rpc('chores:complete', input), keys),
    uncomplete: useInvalidatingMutation(
      (input: { choreId: string; date: string }) => rpc('chores:uncomplete', input),
      keys
    )
  }
}

export function useCalendars() {
  return useQuery({ queryKey: ['calendars'], queryFn: () => rpc('calendars:list', undefined), ...LIVE })
}

export interface EventDraft {
  calendarId: string
  title: string
  location: string
  date: string // yyyy-MM-dd
  startTime: string // HH:mm
  endTime: string // HH:mm
  allDay: boolean
  personIds: string[]
  repeat: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly'
}

export function useEventMutations() {
  const keys = [['occurrences']]
  const create = useInvalidatingMutation(
    (input: EventCreateInput) => rpc('events:create', input),
    keys
  )
  const update = useInvalidatingMutation(
    (input: EventUpdateInput) => rpc('events:update', input),
    keys
  )
  const remove = useInvalidatingMutation(
    (input: EventDeleteInput) => rpc('events:delete', input),
    keys
  )
  return { create, update, remove }
}

export function useAiImport() {
  return useInvalidatingMutation(
    (input: { text: string; images: string[]; tz: string }) => rpc('ai:importEvents', input),
    [['occurrences']]
  )
}

export function useAvatarMutation() {
  return useInvalidatingMutation((input: AvatarSetInput) => rpc('people:setAvatar', input), [['people']])
}
