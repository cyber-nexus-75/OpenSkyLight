export type PersonRole = 'parent' | 'child'

export interface PersonDto {
  id: string
  name: string
  color: string
  role: PersonRole
  sortOrder: number
  /** osl-avatar:// URL, or null when the person has no photo (renderer falls back to initials) */
  avatarUrl: string | null
  /** birthday as MM-DD; null = not set */
  birthday: string | null
  /** birth year for age display; null = hide age */
  birthYear: number | null
}

export interface PersonCreateInput {
  name: string
  color: string
  role: PersonRole
}

export interface PersonUpdateInput {
  id: string
  name?: string
  color?: string
  role?: PersonRole
  sortOrder?: number
  /** MM-DD or null to clear; undefined = leave unchanged */
  birthday?: string | null
  /** null clears; undefined = leave unchanged */
  birthYear?: number | null
}

/** Raw avatar upload: PNG/JPEG image bytes, base64-encoded. Main resizes to 256x256. */
export interface AvatarSetInput {
  personId: string
  data: string
}

export type CalendarProvider = 'local' | 'google' | 'ics' | 'caldav'

export interface CalendarDto {
  id: string
  provider: CalendarProvider
  name: string
  color: string
  readOnly: boolean
  visible: boolean
  /** per-person calendar mapping (caldav): events inherit this person's assignment */
  personId: string | null
}

export interface CalendarCreateInput {
  name: string
  color: string
}

export interface CalendarUpdateInput {
  id: string
  name?: string
  color?: string
  visible?: boolean
}

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** Simplified recurrence model used by the UI; converted to/from RRULE strings. */
export interface RecurrenceInput {
  freq: RecurrenceFreq
  interval?: number
  /** 0 = Monday ... 6 = Sunday (rrule convention) */
  byWeekdays?: number[]
  /** ISO date (inclusive last day the rule applies) */
  untilDate?: string
  count?: number
}

export type EventStatus = 'confirmed' | 'cancelled'

export interface EventDto {
  id: string
  calendarId: string
  title: string
  description: string | null
  location: string | null
  /** UTC ISO instant */
  startAt: string
  endAt: string
  /** IANA zone the event was created in */
  tz: string
  allDay: boolean
  rrule: string | null
  recurrence: RecurrenceInput | null
  recurringEventId: string | null
  originalStartAt: string | null
  status: EventStatus
  readOnly: boolean
  personIds: string[]
}

export interface OccurrenceDto {
  /** Unique per occurrence: `${eventId}|${occurrenceStart}` */
  key: string
  /** Row that holds this occurrence's data (exception row id if overridden) */
  eventId: string
  /** Master series row id (= eventId when not an exception) */
  masterId: string
  calendarId: string
  title: string
  location: string | null
  /** UTC ISO instants */
  start: string
  end: string
  allDay: boolean
  isRecurring: boolean
  readOnly: boolean
  /** Original (pre-override) start; the key used for `this`/`following` edits */
  occurrenceStart: string
  personIds: string[]
}

export interface EventPatch {
  title?: string
  description?: string | null
  location?: string | null
  start?: string
  end?: string
  tz?: string
  allDay?: boolean
  personIds?: string[]
  /** undefined = leave unchanged; null = remove recurrence */
  recurrence?: RecurrenceInput | null
}

export interface EventCreateInput {
  calendarId: string
  title: string
  description?: string | null
  location?: string | null
  start: string
  end: string
  tz: string
  allDay: boolean
  personIds: string[]
  recurrence?: RecurrenceInput | null
}

/** One AI-proposed event, shown on a review screen — never auto-committed. */
export interface AiEventDraft {
  title: string
  /** ISO date (yyyy-MM-dd) the draft lands on */
  date: string
  /** 24h local time, e.g. '16:30'; null = all-day */
  startTime: string | null
  endTime: string | null
  allDay: boolean
  location: string | null
  description: string | null
  /** recurrence freq the model proposed, if any */
  repeat: 'daily' | 'weekly' | 'monthly' | 'yearly' | null
  /** model's own note about what it was unsure of */
  note: string | null
}

export type EditScope = 'this' | 'following' | 'all'

export interface EventUpdateInput {
  id: string
  scope: EditScope
  /** Required when scope is 'this' or 'following' on a recurring event */
  occurrenceStart?: string
  changes: EventPatch
}

export interface EventDeleteInput {
  id: string
  scope: EditScope
  occurrenceStart?: string
}

export type CalendarViewKind = 'home' | 'day' | 'week' | 'month' | 'agenda' | 'chores' | 'tasks' | 'lists' | 'groceries'

export type HomeTileType =
  | 'todayEvents'
  | 'weekAgenda'
  | 'weather'
  | 'choresProgress'
  | 'starBalances'
  | 'list'
  | 'meals'
  | 'clock'
  | 'photo'
  | 'news'
  | 'camera'
  | 'birdnet'
  | 'timer'
  | 'birthdays'
  | 'wallnote'

export interface HomeTileConfig {
  /** 'list' tiles: which list to show */
  listId?: string
  /** 'news' tiles: which preset feed (see shared/rss.ts) */
  feedId?: string
  /** 'camera' tiles: which configured camera to stream */
  cameraId?: string
  /** 'birdnet' tiles: the BirdNET-Go base URL on the LAN */
  birdnetUrl?: string
}

export interface CameraDto {
  id: string
  name: string
}

export interface HomeTile {
  id: string
  type: HomeTileType
  /** grid cell coords (0-based) and spans */
  x: number
  y: number
  w: number
  h: number
  config?: HomeTileConfig
}

export type ListKind = 'grocery' | 'todo' | 'custom'

export interface ListItemDto {
  id: string
  text: string
  checked: boolean
  sortOrder: number
}

export interface ListDto {
  id: string
  name: string
  color: string
  kind: ListKind
  items: ListItemDto[]
}

export type MealSlotKind = 'breakfast' | 'lunch' | 'dinner' | 'snack'

export const MEAL_SLOTS: MealSlotKind[] = ['breakfast', 'lunch', 'dinner', 'snack']

export interface RecipeDto {
  id: string
  title: string
  ingredients: string[]
  instructions: string | null
  tags: string[]
  /** source URL when imported */
  sourceUrl: string | null
}

export interface RecipeCreateInput {
  title: string
  ingredients?: string[]
  instructions?: string | null
  tags?: string[]
  sourceUrl?: string | null
}

export interface RecipeUpdateInput {
  id: string
  title?: string
  ingredients?: string[]
  instructions?: string | null
  tags?: string[]
  sourceUrl?: string | null
}

export interface MealSlotDto {
  id: string
  /** YYYY-MM-DD */
  date: string
  slot: MealSlotKind
  /** free text, or the recipe title when linked to a recipe */
  text: string
  recipeId: string | null
  /** profiles this meal is assigned to (school lunch, dietary needs) */
  personIds: string[]
  sortOrder: number
}

export type ChoreRoutine = 'morning' | 'afternoon' | 'evening' | null

export interface ChoreDto {
  id: string
  title: string
  icon: string | null
  /** null = up for grabs (anyone may claim it) */
  personId: string | null
  /** 2+ person ids alternating weekly; empty = fixed assignment */
  rotationPersonIds: string[]
  starsValue: number
  /** null = one-time chore on anchorDate */
  recurrence: RecurrenceInput | null
  /** YYYY-MM-DD; first day the chore applies (and the only day for one-offs) */
  anchorDate: string
  routine: ChoreRoutine
  /** claimable by any family member; stars go to whoever checks it off */
  upForGrabs: boolean
  /** one-time chore that is due again every day after its anchor */
  repeatAfter: boolean
  /** chores that auto-complete together with this one */
  linkedChoreIds: string[]
  active: boolean
  sortOrder: number
}

export interface ChoreCreateInput {
  title: string
  /** null = up for grabs */
  personId: string | null
  /** 2+ ids = rotate weekly between these people; omit/empty = fixed personId */
  rotationPersonIds?: string[]
  starsValue: number
  recurrence?: RecurrenceInput | null
  anchorDate?: string
  routine?: ChoreRoutine
  upForGrabs?: boolean
  repeatAfter?: boolean
  linkedChoreIds?: string[]
}

export interface ChoreUpdateInput {
  id: string
  title?: string
  personId?: string | null
  /** empty array clears the rotation; undefined = leave unchanged */
  rotationPersonIds?: string[]
  starsValue?: number
  recurrence?: RecurrenceInput | null
  anchorDate?: string
  routine?: ChoreRoutine
  upForGrabs?: boolean
  repeatAfter?: boolean
  linkedChoreIds?: string[]
  active?: boolean
}

export interface DayChoreDto {
  choreId: string
  title: string
  icon: string | null
  /** null = up for grabs */
  personId: string | null
  upForGrabs: boolean
  /** who claimed an up-for-grabs chore (null when not completed or not a grab) */
  claimerId: string | null
  starsValue: number
  routine: ChoreRoutine
  completed: boolean
}

/** One row of the all-tasks view (chores across people + the up-for-grabs pool). */
export interface TaskItemDto {
  choreId: string
  title: string
  icon: string | null
  personId: string | null
  upForGrabs: boolean
  claimerId: string | null
  starsValue: number
  routine: ChoreRoutine
  recurrence: RecurrenceInput | null
  anchorDate: string
  dueToday: boolean
  completedToday: boolean
  /** one-time chore whose anchor date passed without a completion */
  overdue: boolean
}

export interface StarBalanceDto {
  personId: string
  balance: number
}

export interface RewardDto {
  id: string
  title: string
  icon: string | null
  costStars: number
  active: boolean
}

export interface RedemptionDto {
  id: string
  rewardId: string
  rewardTitle: string
  personId: string
  starsSpent: number
  redeemedAt: string
  status: 'pending' | 'granted'
}

export type PantrySource = 'manual' | 'receipt' | 'voice'

export interface PantryItemDto {
  id: string
  name: string
  category: string | null
  unit: string | null
  quantity: number
  minQuantity: number
  source: PantrySource
  updatedAt: string
  createdAt: string
}

export interface ShoppingItemDto {
  id: string
  name: string
  quantity: number
  unit: string | null
  note: string | null
  checked: boolean
  sortOrder: number
  createdAt: string
}

export interface ReceiptScanDto {
  id: string
  store: string | null
  total: number | null
  itemCount: number
  applied: boolean
  scannedAt: string
}

/** One scan's OCR result, returned right after scanning for review before applying. */
export interface ReceiptScanResultDto {
  scan: ReceiptScanDto
  rawText: string
  parsed: { store: string | null; total: number | null; items: ParsedReceiptItem[] }
}

export interface GroceriesStateDto {
  pantry: PantryItemDto[]
  shopping: ShoppingItemDto[]
  lowStock: PantryItemDto[]
}

export interface AppSettings {
  /** 0 = Sunday, 1 = Monday */
  weekStartsOn: 0 | 1
  defaultView: CalendarViewKind
  timeFormat: '12h' | '24h'
  temperatureUnit: 'f' | 'c'
  /** 'auto' = dark from sunset to sunrise (sun times from the weather location) */
  theme: 'light' | 'dark' | 'auto'
  weather: { lat: number; lon: number; label: string } | null
  sleep: { enabled: boolean; start: string; end: string }
  /** dim the screen during these hours (independent of sleep) */
  nightDimming: { enabled: boolean; start: string; end: string; level: number }
  screensaver: { folder: string | null; idleMinutes: number }
  launchOnStartup: boolean
  homeLayout: HomeTile[]
  /** LAN companion web app (phones editing lists/meals/chores) */
  companion: { enabled: boolean; port: number }
  /** background sync cadence for calendar providers, in minutes */
  syncIntervalMinutes: number
  /** chore board: 'all' shows every routine, 'current' only the current part of day */
  routinesDisplay: 'all' | 'current'
  /** grocery store used for order handoff links (Fry's/Kroger by default) */
  groceries: { storeBaseUrl: string }
}

import { DEFAULT_HOME_LAYOUT } from '../home'
import { DEFAULT_STORE_BASE_URL } from '../groceries/frys'
import type { ParsedReceiptItem } from '../groceries/receiptParse'

export const DEFAULT_SETTINGS: AppSettings = {
  weekStartsOn: 0,
  defaultView: 'home',
  timeFormat: '12h',
  temperatureUnit: 'f',
  theme: 'auto',
  weather: null,
  sleep: { enabled: false, start: '21:30', end: '06:30' },
  nightDimming: { enabled: false, start: '21:00', end: '06:30', level: 40 },
  screensaver: { folder: null, idleMinutes: 10 },
  launchOnStartup: false,
  homeLayout: DEFAULT_HOME_LAYOUT,
  companion: { enabled: false, port: 8420 },
  syncIntervalMinutes: 15,
  routinesDisplay: 'all',
  groceries: { storeBaseUrl: DEFAULT_STORE_BASE_URL }
}

/** Touch-friendly person color palette (Skylight-style) */
export const PERSON_COLORS = [
  '#E5484D', // red
  '#F76B15', // orange
  '#FFB224', // amber
  '#46A758', // green
  '#12A594', // teal
  '#0091FF', // blue
  '#6E56CF', // violet
  '#D6409F', // pink
  '#8E4EC6', // purple
  '#00749E' // deep cyan
] as const

export const CALENDAR_COLORS = PERSON_COLORS
