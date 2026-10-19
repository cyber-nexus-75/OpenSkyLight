import { describe, expect, it } from 'vitest'
import { parseDavEvent, rowToVCalendar } from '../../src/main/sync/caldavMap'

const deviceTz = 'America/Denver'

function wrapVevent(props: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', ...props, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
}

describe('parseDavEvent', () => {
  it('maps a simple timed event with a TZID', () => {
    const ics = wrapVevent([
      'UID:abc-1',
      'SUMMARY:Soccer practice',
      'DTSTART;TZID=America/Denver:20260310T160000',
      'DTEND;TZID=America/Denver:20260310T170000'
    ])
    const m = parseDavEvent('/cal/abc-1.ics', '"etag1"', ics, deviceTz)
    expect(m).not.toBeNull()
    expect(m!.title).toBe('Soccer practice')
    expect(m!.tz).toBe('America/Denver')
    expect(m!.allDay).toBe(false)
    // 2026-03-10 Denver is MDT (UTC-6): 16:00 local = 22:00Z
    expect(m!.startAt).toBe('2026-03-10T22:00:00Z')
    expect(m!.status).toBe('confirmed')
    expect(m!.href).toBe('/cal/abc-1.ics')
    expect(m!.etag).toBe('"etag1"')
  })

  it('maps an all-day event to a midnight-in-device-tz instant and extends short ends', () => {
    const ics = wrapVevent([
      'UID:abc-2',
      'SUMMARY:No school',
      'DTSTART;VALUE=DATE:20260401',
      'DTEND;VALUE=DATE:20260401'
    ])
    const m = parseDavEvent('/cal/abc-2.ics', '"e2"', ics, deviceTz)!
    expect(m!.allDay).toBe(true)
    expect(m!.startAt).toBe('2026-04-01T06:00:00Z') // midnight Denver (MDT, UTC-6)
    // end <= start → extended by one day
    expect(Date.parse(m!.endAt) - Date.parse(m!.startAt)).toBe(24 * 3600 * 1000)
  })

  it('maps RRULE + EXDATE into the local recurrence model', () => {
    const ics = wrapVevent([
      'UID:abc-3',
      'SUMMARY:Swim class',
      'DTSTART;TZID=America/Denver:20260303T170000',
      'DTEND;TZID=America/Denver:20260303T180000',
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
      'EXDATE;TZID=America/Denver:20260310T170000'
    ])
    const m = parseDavEvent('/cal/abc-3.ics', '"e3"', ics, deviceTz)!
    expect(m!.rrule).toBe('FREQ=WEEKLY;BYDAY=TU')
    // 2026-03-10 is MDT (UTC-6): 17:00 local = 23:00Z (DST shift from the 03-03 master)
    expect(m!.exdates).toEqual(['2026-03-10T23:00:00Z'])
    expect(m!.rdates).toEqual([])
  })

  it('keeps DST-shifting occurrences distinct across the spring-forward boundary', () => {
    // weekly 17:00 Denver starting before DST (MST) and continuing after (MDT)
    const ics = wrapVevent([
      'UID:abc-4',
      'SUMMARY:Music lesson',
      'DTSTART;TZID=America/Denver:20260303T170000',
      'DTEND;TZID=America/Denver:20260303T180000',
      'RRULE:FREQ=WEEKLY;BYDAY=WE',
      'EXDATE;TZID=America/Denver:20260311T170000'
    ])
    const m = parseDavEvent('/x', '"e"', ics, deviceTz)!
    const master = m.exdates.length === 0 ? null : m
    expect(master).not.toBeNull()
    // master start 03-03 (MST): 17:00 = 00:00Z next day
    expect(m.startAt).toBe('2026-03-04T00:00:00Z')
    // the excluded 03-11 occurrence (MDT): 17:00 = 23:00Z same day — a different UTC instant
    expect(m.exdates).toEqual(['2026-03-11T23:00:00Z'])
  })

  it('maps an exception instance via RECURRENCE-ID', () => {
    const ics = wrapVevent([
      'UID:abc-5',
      'SUMMARY:Moved piano lesson',
      'DTSTART;TZID=America/Denver:20260305T140000',
      'DTEND;TZID=America/Denver:20260305T150000',
      'RECURRENCE-ID;TZID=America/Denver:20260303T140000'
    ])
    const m = parseDavEvent('/cal/abc-5.ics', '"e5"', ics, deviceTz)!
    expect(m.recurrenceId).toBe('2026-03-03T21:00:00Z') // MST
    expect(m.startAt).toBe('2026-03-05T21:00:00Z')
    expect(m.rrule).toBeNull()
  })

  it('maps STATUS:CANCELLED and survives missing times', () => {
    const ics = wrapVevent(['UID:abc-6', 'SUMMARY:Old thing', 'STATUS:CANCELLED'])
    const m = parseDavEvent('/cal/abc-6.ics', '"e6"', ics, deviceTz)!
    expect(m.status).toBe('cancelled')
  })

  it('returns null for garbage input rather than throwing', () => {
    expect(parseDavEvent('/x', '"e"', 'not ics at all', deviceTz)).toBeNull()
    expect(parseDavEvent('/x', '"e"', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', deviceTz)).toBeNull()
  })
})

describe('rowToVCalendar', () => {
  const baseRow = {
    uid: 'uid-1',
    title: 'Dentist — Leo',
    description: 'Bring the form',
    location: 'Office',
    startAt: '2026-03-10T23:00:00Z',
    endAt: '2026-04-01T00:00:00Z',
    tz: 'America/Denver',
    allDay: false,
    rrule: 'FREQ=WEEKLY;BYDAY=TU',
    exdates: ['2026-03-10T23:00:00Z'],
    rdates: [],
    personIds: ['p1', 'p2'],
    recurrenceIdIso: null
  }

  it('round-trips a timed recurring event with EXDATE across a DST boundary', () => {
    const ics = rowToVCalendar(baseRow)
    const back = parseDavEvent('/x', '"e"', ics, deviceTz)!
    expect(back.title).toBe(baseRow.title)
    expect(back.description).toBe(baseRow.description)
    expect(back.location).toBe(baseRow.location)
    expect(back.rrule).toBe(baseRow.rrule)
    // 23:00Z → 17:00 MDT on 03-10 (the EXDATE target survives the DST round-trip)
    expect(back.startAt).toBe(baseRow.startAt)
    expect(back.exdates).toEqual(baseRow.exdates)
  })

  it('escapes iCalendar text separators', () => {
    const ics = rowToVCalendar({ ...baseRow, title: 'Meeting, part 1; intro', description: 'line1\nline2' })
    expect(ics).toContain('SUMMARY:Meeting\\, part 1\\; intro')
    expect(ics).toContain('DESCRIPTION:line1\\nline2')
  })

  it('emits DATE values for all-day events', () => {
    const ics = rowToVCalendar({ ...baseRow, allDay: true, rrule: null, exdates: [] })
    expect(ics).toMatch(/DTSTART;VALUE=DATE:\d{8}/)
    expect(ics).toContain('X-OSL-PEOPLE:p1,p2')
  })

  it('carries RECURRENCE-ID for exception instances', () => {
    const ics = rowToVCalendar({ ...baseRow, rrule: null, exdates: [], recurrenceIdIso: '2026-03-03T21:00:00Z' })
    expect(ics).toMatch(/RECURRENCE-ID;TZID=America\/Denver:20260303T140000/)
  })
})
