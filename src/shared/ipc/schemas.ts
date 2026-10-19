import { z } from 'zod'

const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid ISO datetime')
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid ISO date')
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'invalid color')
const id = z.string().min(1)

export const personCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: hexColor,
  role: z.enum(['parent', 'child'])
})

export const personUpdateSchema = z.object({
  id,
  name: z.string().trim().min(1).max(60).optional(),
  color: hexColor.optional(),
  role: z.enum(['parent', 'child']).optional(),
  sortOrder: z.number().int().optional()
})
export const avatarSetSchema = z.object({
  personId: id,
  // base64-encoded PNG/JPEG image bytes
  data: z.string().min(1)
})

export const calendarCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: hexColor
})

export const calendarUpdateSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80).optional(),
  color: hexColor.optional(),
  visible: z.boolean().optional()
})

export const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(99).optional(),
  byWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  untilDate: isoDate.optional(),
  count: z.number().int().min(1).max(999).optional()
})

export const eventCreateSchema = z.object({
  calendarId: id,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullish(),
  location: z.string().max(300).nullish(),
  start: isoInstant,
  end: isoInstant,
  tz: z.string().min(1),
  allDay: z.boolean(),
  personIds: z.array(id).max(20),
  recurrence: recurrenceSchema.nullish()
})

export const eventPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  start: isoInstant.optional(),
  end: isoInstant.optional(),
  tz: z.string().min(1).optional(),
  allDay: z.boolean().optional(),
  personIds: z.array(id).max(20).optional(),
  recurrence: recurrenceSchema.nullable().optional()
})

export const eventUpdateSchema = z.object({
  id,
  scope: z.enum(['this', 'following', 'all']),
  occurrenceStart: isoInstant.optional(),
  changes: eventPatchSchema
})

export const eventDeleteSchema = z.object({
  id,
  scope: z.enum(['this', 'following', 'all']),
  occurrenceStart: isoInstant.optional()
})

export const occurrenceQuerySchema = z.object({
  start: isoInstant,
  end: isoInstant
})

const homeTileSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum([
    'todayEvents',
    'weekAgenda',
    'weather',
    'choresProgress',
    'starBalances',
    'list',
    'meals',
    'clock',
    'photo',
    'news',
    'camera',
    'birdnet',
    'timer'
  ]),
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(5),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(6),
  // value bounds must be >= what sanitizeLayout keeps (1..200), or a renderable
  // layout could be unsaveable
  config: z
    .object({
      listId: z.string().min(1).max(200).optional(),
      feedId: z.string().min(1).max(200).optional(),
      cameraId: z.string().min(1).max(200).optional(),
      birdnetUrl: z.string().min(1).max(200).optional()
    })
    .optional()
})

export const rssFeedSchema = z.object({ feedId: z.string().min(1).max(40) })

export const birdnetUrlSchema = z.object({
  url: z
    .string()
    .trim()
    .max(500)
    .regex(/^https?:\/\/.+/i, 'Must be an http:// or https:// URL')
})

export const cameraAddSchema = z.object({
  name: z.string().trim().min(1).max(60),
  url: z
    .string()
    .trim()
    .max(500)
    .regex(/^rtsps?:\/\/.+/i, 'Must be an rtsp:// or rtsps:// URL')
})

export const cameraIdSchema = z.object({ cameraId: id })
export const cameraSessionSchema = z.object({ sessionId: id })

export const settingsPatchSchema = z.object({
  patch: z
    .object({
      weekStartsOn: z.union([z.literal(0), z.literal(1)]).optional(),
      defaultView: z.enum(['home', 'day', 'week', 'month', 'agenda', 'chores', 'lists']).optional(),
      homeLayout: z.array(homeTileSchema).max(24).optional(),
      timeFormat: z.enum(['12h', '24h']).optional(),
      temperatureUnit: z.enum(['f', 'c']).optional(),
      theme: z.enum(['light', 'dark', 'auto']).optional(),
      weather: z.object({ lat: z.number(), lon: z.number(), label: z.string() }).nullable().optional(),
      sleep: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }).optional(),
      screensaver: z.object({ folder: z.string().nullable(), idleMinutes: z.number().int().min(1).max(120) }).optional(),
      launchOnStartup: z.boolean().optional(),
      companion: z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535) }).optional(),
      syncIntervalMinutes: z.number().int().min(5).max(1440).optional()
    })
    .strict()
})

export const idSchema = z.object({ id })
export const voidSchema = z.void().or(z.undefined()).or(z.null())

export const googleCredentialsSchema = z.object({
  clientId: z.string().trim().min(10),
  clientSecret: z.string().trim().min(5)
})

export const accountIdSchema = z.object({ accountId: id })

export const googleCalendarSelectSchema = z.object({
  accountId: id,
  googleCalendarId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  color: hexColor,
  readOnly: z.boolean(),
  selected: z.boolean()
})

export const icsAddSchema = z.object({
  url: z.string().trim().url().max(2000),
  name: z.string().trim().min(1).max(80),
  color: hexColor
})
export const caldavConnectSchema = z.object({
  baseUrl: z.string().trim().url().max(2000).refine((u) => u.startsWith('https://') || u.startsWith('http://'), 'Server URL must be http(s)'),
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(400)
})
export const caldavCalendarSelectSchema = z.object({
  accountId: id,
  calendarUrl: z.string().trim().url().max(2000),
  name: z.string().trim().min(1).max(120),
  color: hexColor,
  readOnly: z.boolean(),
  selected: z.boolean(),
  personId: id.nullable()
})
export const caldavCalendarPersonSchema = z.object({
  calendarId: id,
  personId: id.nullable()
})

const routine = z.enum(['morning', 'evening']).nullable()

export const choreCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  personId: id,
  starsValue: z.number().int().min(0).max(99),
  recurrence: recurrenceSchema.nullish(),
  anchorDate: isoDate.optional(),
  routine: routine.optional()
})

export const choreUpdateSchema = z.object({
  id,
  title: z.string().trim().min(1).max(120).optional(),
  personId: id.optional(),
  starsValue: z.number().int().min(0).max(99).optional(),
  recurrence: recurrenceSchema.nullable().optional(),
  anchorDate: isoDate.optional(),
  routine: routine.optional(),
  active: z.boolean().optional()
})

export const choreDaySchema = z.object({ date: isoDate })
export const choreCheckSchema = z.object({ choreId: id, date: isoDate })

export const rewardCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  costStars: z.number().int().min(1).max(9999)
})

export const rewardUpdateSchema = z.object({
  id,
  title: z.string().trim().min(1).max(120).optional(),
  costStars: z.number().int().min(1).max(9999).optional(),
  active: z.boolean().optional()
})

export const redeemSchema = z.object({ rewardId: id, personId: id })
export const grantSchema = z.object({ redemptionId: id })

export const listCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: hexColor,
  kind: z.enum(['grocery', 'todo', 'custom'])
})

export const listUpdateSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80).optional(),
  color: hexColor.optional()
})

export const listItemAddSchema = z.object({ listId: id, text: z.string().trim().min(1).max(300) })
export const listIdSchema = z.object({ listId: id })

export const mealsRangeSchema = z.object({ start: isoDate, end: isoDate })
export const mealSetSchema = z.object({
  date: isoDate,
  slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
  text: z.string().trim().max(200).nullable()
})

export const citySearchSchema = z.object({ query: z.string().trim().min(2).max(80) })

export const pinVerifySchema = z.object({ pin: z.string().regex(/^\d{4,8}$/) })

export const pinSetSchema = z.object({ pin: z.string().regex(/^\d{4,8}$/).nullable() })
