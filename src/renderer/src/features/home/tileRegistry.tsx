import type { ComponentType } from 'react'
import type { CalendarViewKind, HomeTileType } from '@shared/types'
import {
  BirdNetTile,
  CameraTile,
  TimerTile,
  ChoresProgressTile,
  ClockTile,
  ListTile,
  MealsTile,
  NewsTile,
  PhotoTile,
  StarBalancesTile,
  TodayEventsTile,
  WeatherTile,
  WeekAgendaTile,
  BirthdaysTile,
  WallNoteTile,
  type TileProps
} from './tiles'

export interface TileMeta {
  label: string
  description: string
  component: ComponentType<TileProps>
  /** view-mode tap navigates here */
  navTarget?: CalendarViewKind
}

export const TILE_REGISTRY: Record<HomeTileType, TileMeta> = {
  todayEvents: {
    label: "Today's events",
    description: 'Everything on the calendar today',
    component: TodayEventsTile,
    navTarget: 'day'
  },
  weekAgenda: {
    label: 'This week',
    description: 'A compact 7-day agenda',
    component: WeekAgendaTile,
    navTarget: 'agenda'
  },
  weather: {
    label: 'Weather',
    description: 'Current conditions and forecast',
    component: WeatherTile
  },
  choresProgress: {
    label: 'Chores progress',
    description: "Each person's chores for today",
    component: ChoresProgressTile,
    navTarget: 'chores'
  },
  starBalances: {
    label: 'Star balances',
    description: 'Stars earned by each child',
    component: StarBalancesTile,
    navTarget: 'chores'
  },
  list: {
    label: 'List',
    description: 'Unchecked items from a list you pick',
    component: ListTile,
    navTarget: 'lists'
  },
  meals: {
    label: 'Meals today',
    description: "Today's meal plan",
    component: MealsTile,
    navTarget: 'week'
  },
  clock: {
    label: 'Clock',
    description: 'Time and date',
    component: ClockTile
  },
  photo: {
    label: 'Photo',
    description: 'Cycling photos from your screensaver folder',
    component: PhotoTile
  },
  news: {
    label: 'News headlines',
    description: 'Top stories from a news feed you pick',
    component: NewsTile
  },
  camera: {
    label: 'Camera',
    description: 'Live view from an IP camera (RTSP)',
    component: CameraTile
  },
  birdnet: {
    label: 'Birds',
    description: 'Recent detections from your BirdNET-Go',
    component: BirdNetTile
  },
  timer: {
    label: 'Timers',
    description: 'Countdown timers — set by tap or voice',
    component: TimerTile
  },
  birthdays: {
    label: 'Birthdays',
    description: 'Upcoming birthdays with countdowns',
    component: BirthdaysTile
  },
  wallnote: {
    label: 'Note',
    description: 'A shared family whiteboard — editable here and from the phone',
    component: WallNoteTile
  }
}
