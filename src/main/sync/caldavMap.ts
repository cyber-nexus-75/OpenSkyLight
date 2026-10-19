import ICAL from 'ical.js'
import { DateTime, IANAZone } from 'luxon'
import { isoUtc } from '@shared/dates'

/**
 * Pure mapping between iCalendar VEVENTs (CalDAV) and OpenSkyLight event
 * rows. No Electron or network imports — fully unit-testable, including
 * DST/timezone edge cases (mirrors googleMap.ts).
 */

export interface DavMappedEvent {
  /** the event resource href — our providerEventId for CalDAV */
  href: string
  etag: string
  uid: string
  /** original occurrence start (UTC ISO) when this VEVENT overrides one instance */
  recurrenceId: string | null
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string
  tz: string
  allDay: boolean
  rrule: string | null
  exdates: string[]
  rdates: string[]
  status: 'confirmed' | 'cancelled'
  remoteUpdatedAt: string | null
}

function icalTimeToIso(t: ICAL.Time, deviceTz: string): { iso: string; tz: string; allDay: boolean } {
  const tzid = t.zone?.tzid ?? null
  if (t.isDate) {
    const dt = DateTime.fromObject({ year: t.year, month: t.month, day: t.day }, { zone: deviceTz }).startOf('day')
    return { iso: isoUtc(dt), tz: deviceTz, allDay: true }
  }
  if (tzid === 'UTC' || tzid === 'Z') {
    const dt = DateTime.fromObject(
      { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
      { zone: 'utc' }
    )
    return { iso: isoUtc(dt), tz: 'UTC', allDay: false }
  }
  if (tzid && tzid !== 'floating' && IANAZone.isValidZone(tzid)) {
    const dt = DateTime.fromObject(
      { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
      { zone: tzid }
    )
    return { iso: isoUtc(dt), tz: tzid, allDay: false }
  }
  if (tzid && tzid !== 'floating') {
    const dt = DateTime.fromJSDate(t.toJSDate())
    return { iso: isoUtc(dt), tz: deviceTz, allDay: false }
  }
  const dt = DateTime.fromObject(
    { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second },
    { zone: deviceTz }
  )
  return { iso: isoUtc(dt), tz: deviceTz, allDay: false }
}

export function icalTimeFromIso(iso: string, tz: string, allDay: boolean): ICAL.Time {
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(allDay ? tz : tz)
  if (allDay) {
    return ICAL.Time.fromDateString(dt.toFormat('yyyy-MM-dd'))
  }
  const zone = IANAZone.isValidZone(tz) ? tz : 'UTC'
  const comp = dt.setZone(zone)
  return ICAL.Time.fromDateTimeString(
    comp.toFormat("yyyy-MM-dd'T'HH:mm:ss") + (zone === 'UTC' ? 'Z' : '')
  )
}

/** Parse one calendar-data payload (a full VCALENDAR or a bare VEVENT). */
export function parseDavEvent(
  href: string,
  etag: string,
  ics: string,
  deviceTz: string
): DavMappedEvent | null {
  try {
    const comp = new ICAL.Component(ICAL.parse(ics))
    for (const vtz of comp.getAllSubcomponents('vtimezone')) {
      try {
        const tz = new ICAL.Timezone(vtz)
        if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz)
      } catch {
        // ignore malformed timezone definitions
      }
    }
    const vevent = comp.getFirstSubcomponent('vevent')
    if (!vevent) return null
    const ev = new ICAL.Event(vevent)
    const statusRawFirst = String(vevent.getFirstPropertyValue('status') ?? '').toUpperCase()
    if (!ev.uid) return null
    // cancelled resources may arrive without DTSTART/DTEND; map with placeholders
    if (!ev.startDate) {
      if (statusRawFirst !== 'CANCELLED') return null
      return {
        href,
        etag,
        uid: ev.uid,
        recurrenceId: null,
        title: ev.summary || '(no title)',
        description: ev.description || null,
        location: ev.location || null,
        startAt: '1970-01-01T00:00:00Z',
        endAt: '1970-01-01T00:00:00Z',
        tz: deviceTz,
        allDay: false,
        rrule: null,
        exdates: [],
        rdates: [],
        status: 'cancelled',
        remoteUpdatedAt: null
      }
    }
    const start = icalTimeToIso(ev.startDate, deviceTz)
    const end = ev.endDate ? icalTimeToIso(ev.endDate, deviceTz) : start
    let endIso = end.iso
    if (start.allDay && endIso <= start.iso) {
      endIso = isoUtc(DateTime.fromISO(start.iso, { zone: 'utc' }).setZone(start.tz).plus({ days: 1 }))
    }
    const rruleValue = vevent.getFirstPropertyValue('rrule')
    const exdates: string[] = []
    for (const prop of vevent.getAllProperties('exdate')) {
      for (const v of prop.getValues() as ICAL.Time[]) {
        try {
          exdates.push(icalTimeToIso(v, deviceTz).iso)
        } catch {
          /* skip */
        }
      }
    }
    const rdates: string[] = []
    for (const prop of vevent.getAllProperties('rdate')) {
      for (const v of prop.getValues() as ICAL.Time[]) {
        try {
          rdates.push(icalTimeToIso(v, deviceTz).iso)
        } catch {
          /* skip */
        }
      }
    }
    const recurrenceIdRaw = vevent.getFirstPropertyValue('recurrence-id') as ICAL.Time | null
    const statusRaw = String(vevent.getFirstPropertyValue('status') ?? '').toUpperCase()
    const lastModifiedRaw = vevent.getFirstPropertyValue('last-modified') as ICAL.Time | null
    return {
      href,
      etag,
      uid: ev.uid,
      recurrenceId: recurrenceIdRaw ? icalTimeToIso(recurrenceIdRaw, deviceTz).iso : null,
      title: ev.summary || '(no title)',
      description: ev.description || null,
      location: ev.location || null,
      startAt: start.iso,
      endAt: endIso,
      tz: start.tz,
      allDay: start.allDay,
      rrule: rruleValue ? String(rruleValue) : null,
      exdates,
      rdates,
      status: statusRaw === 'CANCELLED' ? 'cancelled' : 'confirmed',
      remoteUpdatedAt: lastModifiedRaw ? icalTimeToIso(lastModifiedRaw, deviceTz).iso : null
    }
  } catch {
    // one bad VEVENT must not kill the whole pull
    return null
  }
}

export interface RowForPush {
  uid: string
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string
  tz: string
  allDay: boolean
  rrule: string | null
  exdates: string[]
  rdates: string[]
  personIds: string[]
  /** set on exception instances; keeps RECURRENCE-ID in the built VEVENT */
  recurrenceIdIso: string | null
}

function formatDateTimeValue(iso: string, tz: string, allDay: boolean): { params: string; value: string } {
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz)
  if (allDay) return { params: ';VALUE=DATE', value: dt.toFormat('yyyyMMdd') }
  return { params: `;TZID=${tz}`, value: dt.toFormat("yyyyMMdd'T'HHmmss") }
}

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** Build the VCALENDAR body for a PUT from a local row. */
export function rowToVCalendar(row: RowForPush): string {
  const start = formatDateTimeValue(row.startAt, row.tz, row.allDay)
  const end = formatDateTimeValue(row.endAt, row.tz, row.allDay)
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OpenSkyLight//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${row.uid}`,
    `SUMMARY:${escapeText(row.title)}`,
    ...(row.description ? [`DESCRIPTION:${escapeText(row.description)}`] : []),
    ...(row.location ? [`LOCATION:${escapeText(row.location)}`] : []),
    `DTSTART${start.params}:${start.value}`,
    `DTEND${end.params}:${end.value}`,
    ...(row.rrule ? [`RRULE:${row.rrule}`] : []),
    ...(row.exdates.length > 0
      ? [`EXDATE${row.allDay ? ';VALUE=DATE' : `;TZID=${row.tz}`}:${row.exdates
          .map((iso) => formatDateTimeValue(iso, row.tz, row.allDay).value)
          .join(',')}`]
      : []),
    ...(row.rdates.length > 0
      ? [`RDATE${row.allDay ? ';VALUE=DATE' : `;TZID=${row.tz}`}:${row.rdates
          .map((iso) => formatDateTimeValue(iso, row.tz, row.allDay).value)
          .join(',')}`]
      : []),
    ...(row.recurrenceIdIso
      ? [`RECURRENCE-ID${row.allDay ? ';VALUE=DATE' : `;TZID=${row.tz}`}:${formatDateTimeValue(row.recurrenceIdIso, row.tz, row.allDay).value}`]
      : []),
    ...(row.personIds.length > 0 ? [`X-OSL-PEOPLE:${row.personIds.join(',')}`] : []),
    'END:VEVENT',
    'END:VCALENDAR'
  ]
  return lines.join('\r\n') + '\r\n'
}
