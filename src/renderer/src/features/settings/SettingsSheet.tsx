import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AiEventDraft, CalendarDto, ChoreDto, PersonDto, PersonRole, RecurrenceInput, RewardDto } from '@shared/types'
import { PERSON_COLORS } from '@shared/types'
import { describeRecurrence } from '@shared/recurrence/build'
import {
  useAuthMutations,
  useAuthStatus,
  useCalendarMutations,
  useCalendars,
  useCompanionMutations,
  useCompanionStatus,
  useChoreMutations,
  useChores,
  useAvatarMutations,
  useCaldavMutations,
  useCaldavRemoteCalendars,
  useCaldavStatus,
  useCitySearch,
  useRedemptions,
  useRewardMutations,
  useRewards,
  useGoogleMutations,
  useGoogleStatus,
  useIcsMutations,
  usePeople,
  usePeopleMutations,
  useRemoteCalendars,
  useSettings,
  useSettingsMutation,
  useSyncNow,
  useSyncStatus,
  useAiImport,
  useWebdavMutations
} from '../../api/hooks'
import { PinDialog } from '../../components/PinDialog'
import { TimeField } from '../../components/DateTimePickers'
import { ipcInvoke } from '../../api/client'
import { useUi } from '../../stores/uiStore'
import { useToasts } from '../../stores/toastStore'
import { BigButton, Dialog, FieldLabel, SegmentedControl, Sheet, Toggle } from '../../components/ui'
import { OskInput } from '../../components/Osk'
import { PlusIcon } from '../../components/icons'
import { Avatar } from '../../components/Avatar'
import { textOn } from '../../lib/format'
import QRCode from 'qrcode'

type Tab = 'family' | 'calendars' | 'chores' | 'general'

export function SettingsSheet() {
  const open = useUi((s) => s.settingsOpen)
  const setOpen = useUi((s) => s.setSettingsOpen)
  const [tab, setTab] = useState<Tab>('family')
  const [pinError, setPinError] = useState<string | null>(null)
  const { data: auth } = useAuthStatus()
  const authMutations = useAuthMutations()

  const close = (): void => {
    setOpen(false)
    setPinError(null)
    // closing settings re-arms the parental lock immediately
    if (auth?.pinSet) authMutations.lock.mutate(undefined)
  }

  // The PIN gate guards EVERY way into settings (main-side IPC gating is the
  // actual security boundary; this is the matching UX).
  const locked = (auth?.pinSet ?? false) && !(auth?.unlocked ?? false)
  if (open && locked) {
    return (
      <PinDialog
        open
        title="Enter parent PIN"
        error={pinError}
        onClose={close}
        onSubmit={(pin) =>
          authMutations.verifyPin.mutate(
            { pin },
            {
              onSuccess: (res) => {
                if (!res.valid) setPinError('Wrong PIN — try again')
                else setPinError(null)
              }
            }
          )
        }
      />
    )
  }

  return (
    <Sheet open={open} onClose={close} title="Settings" wide>
      <div className="mb-5">
        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={[
            { value: 'family', label: 'Family' },
            { value: 'calendars', label: 'Calendars' },
            { value: 'chores', label: 'Chores' },
            { value: 'general', label: 'General' }
          ]}
        />
      </div>
      {tab === 'family' && <FamilyTab />}
      {tab === 'calendars' && <CalendarsTab />}
      {tab === 'chores' && <ChoresTab />}
      {tab === 'general' && <GeneralTab />}
    </Sheet>
  )
}

function ColorGrid({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {PERSON_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`pressable h-12 w-12 rounded-full ${value === c ? 'ring-4 ring-ink ring-offset-2 ring-offset-card' : ''}`}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  )
}

/** Square-crops the picked photo to 256x256 via canvas, then uploads it as base64 PNG. */
async function processAvatarFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256)
  bitmap.close()
  return canvas.toDataURL('image/png').split(',')[1]!
}

function AvatarPicker({ person }: { person: PersonDto }) {
  const avatarMutations = useAvatarMutations()
  const pick = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg'
    input.onchange = () => {
      const file = input.files?.[0]
      if (file) {
        void processAvatarFile(file)
          .then((data) => avatarMutations.set.mutate({ personId: person.id, data }))
          .catch(() => undefined)
      }
    }
    input.click()
  }
  return (
    <div className="flex items-center gap-4">
      <Avatar person={person} className="h-20 w-20 shrink-0 rounded-full text-2xl" />
      <div className="flex flex-col gap-2">
        <BigButton variant="ghost" onClick={pick}>
          Change photo
        </BigButton>
        {person.avatarUrl && (
          <BigButton variant="ghost" onClick={() => avatarMutations.remove.mutate({ id: person.id })}>
            Remove photo
          </BigButton>
        )}
      </div>
    </div>
  )
}

function FamilyTab() {
  const { data: people = [] } = usePeople()
  const mutations = usePeopleMutations()
  const [editing, setEditing] = useState<PersonDto | 'new' | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(PERSON_COLORS[0])
  const [role, setRole] = useState<PersonRole>('child')
  const [birthday, setBirthday] = useState('')
  const [birthYear, setBirthYear] = useState('')

  const openEditor = (p: PersonDto | 'new'): void => {
    setEditing(p)
    if (p === 'new') {
      setName('')
      setColor(PERSON_COLORS[people.length % PERSON_COLORS.length])
      setRole('child')
      setBirthday('')
      setBirthYear('')
    } else {
      setName(p.name)
      setColor(p.color)
      setRole(p.role)
      setBirthday(p.birthday ?? '')
      setBirthYear(p.birthYear ? String(p.birthYear) : '')
    }
  }

  const save = (): void => {
    if (!name.trim()) return
    if (editing === 'new') mutations.create.mutate({ name: name.trim(), color, role })
    else if (editing)
      mutations.update.mutate({
        id: editing.id,
        name: name.trim(),
        color,
        role,
        birthday: birthday || null,
        birthYear: birthYear ? Number(birthYear) : null
      })
    setEditing(null)
  }

  return (
    <div className="flex flex-col gap-3">
      {people.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => openEditor(p)}
          className="pressable flex items-center gap-4 rounded-2xl bg-paper-deep/50 p-3 text-left hover:bg-paper-deep"
        >
          <Avatar person={p} className="h-14 w-14 shrink-0 rounded-full text-lg" />
          <span className="flex-1">
            <span className="block text-xl font-bold">{p.name}</span>
            <span className="block text-sm font-bold text-ink-faint capitalize">{p.role}</span>
          </span>
        </button>
      ))}
      <BigButton variant="ghost" onClick={() => openEditor('new')}>
        <span className="flex items-center justify-center gap-2">
          <PlusIcon size={20} /> Add family member
        </span>
      </BigButton>

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add family member' : 'Edit family member'}
      >
        <div className="flex flex-col gap-4">
          {editing !== 'new' && editing && <AvatarPicker person={editing} />}
          <div>
            <FieldLabel>Name</FieldLabel>
            <OskInput value={name} onChange={setName} placeholder="Name" autoFocus={editing === 'new'} />
          </div>
          <div>
            <FieldLabel>Color</FieldLabel>
            <ColorGrid value={color} onChange={setColor} />
          </div>
          <div>
            <FieldLabel>Role</FieldLabel>
            <SegmentedControl
              value={role}
              onChange={setRole}
              options={[
                { value: 'parent', label: 'Parent' },
                { value: 'child', label: 'Child' }
              ]}
            />
          </div>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <FieldLabel>Birthday</FieldLabel>
              <input
                type="text"
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
                placeholder="MM-DD"
                className="min-h-11 w-full rounded-xl border border-line bg-paper px-3 text-base font-semibold outline-none placeholder:text-ink-faint focus:border-ember"
              />
            </div>
            <div className="w-28">
              <FieldLabel>Year</FieldLabel>
              <input
                type="text"
                value={birthYear}
                onChange={(e) => setBirthYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="optional"
                className="min-h-11 w-full rounded-xl border border-line bg-paper px-3 text-base font-semibold outline-none placeholder:text-ink-faint focus:border-ember"
              />
            </div>
          </div>
          <div className="mt-2 flex gap-3">
            {editing !== 'new' && editing && (
              <BigButton
                variant="danger"
                onClick={() => {
                  mutations.remove.mutate({ id: editing.id })
                  setEditing(null)
                }}
              >
                Remove
              </BigButton>
            )}
            <div className="flex-1" />
            <BigButton variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </BigButton>
            <BigButton onClick={save} disabled={!name.trim()}>
              Save
            </BigButton>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function SyncStatusRow() {
  const { data: status } = useSyncStatus()
  const syncNow = useSyncNow()
  if (!status) return null
  const dot = status.state === 'error' ? 'bg-ember' : status.state === 'syncing' ? 'bg-sun' : 'bg-[#46A758]'
  const label =
    status.state === 'syncing' ? 'Syncing…' : status.state === 'error' ? (status.lastError ?? 'Sync error') : 'Up to date'
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-paper-deep/50 px-4 py-3">
      <span className={`h-3.5 w-3.5 rounded-full ${dot}`} />
      <span className="min-w-0 flex-1 truncate text-base font-bold text-ink-soft">{label}</span>
      <button
        type="button"
        onClick={() => syncNow.mutate(undefined)}
        className="pressable rounded-full border-2 border-line bg-card px-4 py-1.5 text-sm font-bold text-ink-soft"
      >
        Sync now
      </button>
    </div>
  )
}

function CalDavSection() {
  const { data: status } = useCaldavStatus()
  const caldav = useCaldavMutations()
  const { data: people = [] } = usePeople()
  const [baseUrl, setBaseUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null)
  const { data: remoteCals = [], isLoading: remoteLoading } = useCaldavRemoteCalendars(expandedAccount)
  if (!status) return null
  const personOptions = [
    { value: '', label: 'Shared (family)' },
    ...people.map((p) => ({ value: p.id, label: p.name }))
  ]
  return (
    <div>
      <FieldLabel>Nextcloud / CalDAV</FieldLabel>
      {status.accounts.length === 0 ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
          <p className="text-base font-semibold text-ink-soft">
            Two-way sync with your Nextcloud (or any CalDAV server). Use a Nextcloud app
            password (Settings → Security → Devices &amp; sessions) — not your login password.
          </p>
          <OskInput value={baseUrl} onChange={setBaseUrl} placeholder="https://cloud.example.com/remote.php/dav/" />
          <OskInput value={username} onChange={setUsername} placeholder="Username" />
          <OskInput value={password} onChange={setPassword} placeholder="App password" />
          <BigButton
            onClick={() =>
              caldav.connect.mutate(
                { baseUrl: baseUrl.trim(), username: username.trim(), password },
                {
                  onSuccess: () => {
                    setBaseUrl('')
                    setUsername('')
                    setPassword('')
                  }
                }
              )
            }
            disabled={!baseUrl.trim() || !username.trim() || !password}
          >
            {caldav.connect.isPending ? 'Connecting…' : 'Add CalDAV account'}
          </BigButton>
          {caldav.connect.isError && (
            <p className="text-sm font-bold text-ember-deep">{caldav.connect.error.message}</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {status.accounts.map((account) => (
            <div key={account.id} className="rounded-2xl bg-paper-deep/50 p-3">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg font-bold">{account.username}</span>
                  <span className="block truncate text-sm font-bold text-ink-faint">{account.baseUrl}</span>
                  {account.error && <span className="block text-sm font-bold text-ember-deep">{account.error}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => setExpandedAccount(expandedAccount === account.id ? null : account.id)}
                  className="pressable rounded-full border-2 border-line bg-card px-4 py-1.5 text-sm font-bold text-ink-soft"
                >
                  {expandedAccount === account.id ? 'Hide calendars' : 'Choose calendars'}
                </button>
                <button
                  type="button"
                  onClick={() => caldav.disconnect.mutate({ accountId: account.id })}
                  className="pressable rounded-full border-2 border-ember-soft px-4 py-1.5 text-sm font-bold text-ember-deep"
                >
                  Disconnect
                </button>
              </div>
              {expandedAccount === account.id && (
                <div className="mt-3 flex flex-col gap-2">
                  {remoteLoading && <p className="text-sm font-bold text-ink-faint">Loading calendars…</p>}
                  {remoteCals.map((rc) => (
                    <div key={rc.url} className="flex items-center gap-3 rounded-xl bg-card px-3 py-2">
                      <span className="h-5 w-5 shrink-0 rounded-full" style={{ backgroundColor: rc.color }} />
                      <span className="min-w-0 flex-1 truncate text-base font-bold">{rc.name}</span>
                      <select
                        className="rounded-xl border-2 border-line bg-card px-2 py-1 text-sm font-bold text-ink-soft"
                        value={rc.personId ?? ''}
                        onChange={(e) => {
                          const personId = e.target.value || null
                          caldav.setCalendarSelected.mutate({
                            accountId: account.id,
                            calendarUrl: rc.url,
                            name: rc.name,
                            color: rc.color,
                            readOnly: rc.readOnly,
                            selected: true,
                            personId
                          })
                        }}
                        aria-label={`Map ${rc.name} to a person`}
                      >
                        {personOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <Toggle
                        checked={rc.selected}
                        onChange={(selected) =>
                          caldav.setCalendarSelected.mutate({
                            accountId: account.id,
                            calendarUrl: rc.url,
                            name: rc.name,
                            color: rc.color,
                            readOnly: rc.readOnly,
                            selected,
                            personId: rc.personId
                          })
                        }
                        label={`Sync ${rc.name}`}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function GoogleSection() {
  const { data: status } = useGoogleStatus()
  const google = useGoogleMutations()
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null)
  const { data: remoteCals = [], isLoading: remoteLoading } = useRemoteCalendars(expandedAccount)

  if (!status) return null

  const saveAndConnect = (): void => {
    google.setCredentials.mutate(
      { clientId, clientSecret },
      { onSuccess: () => google.connect.mutate(undefined) }
    )
  }

  return (
    <div>
      <FieldLabel>Google Calendar</FieldLabel>
      {!status.configured ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
          <p className="text-base font-semibold text-ink-soft">
            Two-way sync uses your own (free) Google Cloud project. Create a{' '}
            <span className="font-extrabold">Desktop app</span> OAuth client in the Google Cloud console, enable the
            Calendar API, and paste the credentials here.
          </p>
          <OskInput value={clientId} onChange={setClientId} placeholder="OAuth client ID" />
          <OskInput value={clientSecret} onChange={setClientSecret} placeholder="OAuth client secret" />
          <BigButton onClick={saveAndConnect} disabled={clientId.trim().length < 10 || clientSecret.trim().length < 5}>
            {google.connect.isPending ? 'Waiting for browser sign-in…' : 'Save & connect Google'}
          </BigButton>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {status.accounts.map((account) => (
            <div key={account.id} className="rounded-2xl bg-paper-deep/50 p-3">
              <div className="flex items-center gap-3">
                <span className="flex-1">
                  <span className="block text-lg font-bold">{account.email}</span>
                  {account.error && <span className="block text-sm font-bold text-ember-deep">{account.error}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => setExpandedAccount(expandedAccount === account.id ? null : account.id)}
                  className="pressable rounded-full border-2 border-line bg-card px-4 py-1.5 text-sm font-bold text-ink-soft"
                >
                  {expandedAccount === account.id ? 'Hide calendars' : 'Choose calendars'}
                </button>
                <button
                  type="button"
                  onClick={() => google.disconnect.mutate({ accountId: account.id })}
                  className="pressable rounded-full border-2 border-ember-soft px-4 py-1.5 text-sm font-bold text-ember-deep"
                >
                  Disconnect
                </button>
              </div>
              {expandedAccount === account.id && (
                <div className="mt-3 flex flex-col gap-2">
                  {remoteLoading && <p className="text-sm font-bold text-ink-faint">Loading calendars…</p>}
                  {remoteCals.map((rc) => (
                    <div key={rc.id} className="flex items-center gap-3 rounded-xl bg-card px-3 py-2">
                      <span className="h-5 w-5 rounded-full" style={{ backgroundColor: rc.color }} />
                      <span className="min-w-0 flex-1 truncate text-base font-bold">
                        {rc.name}
                        {rc.readOnly && <span className="ml-2 text-xs font-extrabold text-ink-faint">READ-ONLY</span>}
                      </span>
                      <Toggle
                        checked={rc.selected}
                        onChange={(selected) =>
                          google.setCalendarSelected.mutate({
                            accountId: account.id,
                            googleCalendarId: rc.id,
                            name: rc.name,
                            color: rc.color,
                            readOnly: rc.readOnly,
                            selected
                          })
                        }
                        label={`Sync ${rc.name}`}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          <BigButton variant="ghost" onClick={() => google.connect.mutate(undefined)} disabled={google.connect.isPending}>
            {google.connect.isPending ? 'Waiting for browser sign-in…' : 'Add Google account'}
          </BigButton>
        </div>
      )}
    </div>
  )
}

function IcsSection() {
  const { data: calendars = [] } = useCalendars()
  const calendarMutations = useCalendarMutations()
  const ics = useIcsMutations()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const feeds = calendars.filter((c) => c.provider === 'ics')

  const add = (): void => {
    ics.add.mutate(
      { url: url.trim(), name: name.trim() || 'Subscribed calendar', color: PERSON_COLORS[9] },
      {
        onSuccess: () => {
          setUrl('')
          setName('')
        }
      }
    )
  }

  return (
    <div>
      <FieldLabel>Subscribed feeds (ICS)</FieldLabel>
      <div className="flex flex-col gap-2">
        {feeds.map((c) => (
          <div key={c.id} className="flex items-center gap-3 rounded-2xl bg-paper-deep/50 p-3">
            <span className="h-6 w-6 rounded-full" style={{ backgroundColor: c.color }} />
            <span className="min-w-0 flex-1 truncate text-lg font-bold">{c.name}</span>
            <Toggle
              checked={c.visible}
              onChange={(visible) => calendarMutations.update.mutate({ id: c.id, visible })}
              label="Visible"
            />
            <button
              type="button"
              onClick={() => calendarMutations.remove.mutate({ id: c.id })}
              className="pressable rounded-full border-2 border-ember-soft px-4 py-1.5 text-sm font-bold text-ember-deep"
            >
              Remove
            </button>
          </div>
        ))}
        <div className="flex flex-col gap-2 rounded-2xl bg-paper-deep/50 p-3 sm:flex-row">
          <OskInput value={url} onChange={setUrl} placeholder="https://… .ics feed URL" className="flex-[2]" />
          <OskInput value={name} onChange={setName} placeholder="Name" className="flex-1" />
          <BigButton variant="ghost" onClick={add} disabled={!/^https?:\/\/.+/.test(url.trim()) || ics.add.isPending}>
            Add
          </BigButton>
        </div>
      </div>
    </div>
  )
}

function CalendarsTab() {
  const { data: calendars = [] } = useCalendars()
  const mutations = useCalendarMutations()
  const [editing, setEditing] = useState<CalendarDto | 'new' | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(PERSON_COLORS[5])
  const manageable = calendars.filter((c) => c.provider !== 'ics')

  const openEditor = (c: CalendarDto | 'new'): void => {
    setEditing(c)
    setName(c === 'new' ? '' : c.name)
    setColor(c === 'new' ? PERSON_COLORS[5] : c.color)
  }

  const save = (): void => {
    if (!name.trim()) return
    if (editing === 'new') mutations.create.mutate({ name: name.trim(), color })
    else if (editing) mutations.update.mutate({ id: editing.id, name: name.trim(), color })
    setEditing(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <SyncStatusRow />
      <GoogleSection />
      <CalDavSection />
      <IcsSection />
      <div>
        <FieldLabel>Calendars on this display</FieldLabel>
        <div className="flex flex-col gap-2">
          {manageable.map((c) => (
            <div key={c.id} className="flex items-center gap-4 rounded-2xl bg-paper-deep/50 p-3">
              <button
                type="button"
                onClick={() => openEditor(c)}
                className="pressable flex flex-1 items-center gap-4 text-left"
              >
                <span className="h-8 w-8 rounded-full" style={{ backgroundColor: c.color }} />
                <span className="flex-1">
                  <span className="block text-xl font-bold">{c.name}</span>
                  <span className="block text-sm font-bold text-ink-faint capitalize">{c.provider}</span>
                </span>
              </button>
              <Toggle
                checked={c.visible}
                onChange={(visible) => mutations.update.mutate({ id: c.id, visible })}
                label="Visible"
              />
            </div>
          ))}
          <BigButton variant="ghost" onClick={() => openEditor('new')}>
            <span className="flex items-center justify-center gap-2">
              <PlusIcon size={20} /> Add local calendar
            </span>
          </BigButton>
        </div>
      </div>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add calendar' : 'Edit calendar'}>
        <div className="flex flex-col gap-4">
          <div>
            <FieldLabel>Name</FieldLabel>
            <OskInput value={name} onChange={setName} placeholder="Calendar name" autoFocus={editing === 'new'} />
          </div>
          <div>
            <FieldLabel>Color</FieldLabel>
            <ColorGrid value={color} onChange={setColor} />
          </div>
          <div className="mt-2 flex gap-3">
            {editing !== 'new' && editing && (
              <BigButton
                variant="danger"
                onClick={() => {
                  mutations.remove.mutate({ id: editing.id })
                  setEditing(null)
                }}
              >
                Delete
              </BigButton>
            )}
            <div className="flex-1" />
            <BigButton variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </BigButton>
            <BigButton onClick={save} disabled={!name.trim()}>
              Save
            </BigButton>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function Stepper({ value, onChange, min = 0, max = 99 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        className="pressable flex h-12 w-12 items-center justify-center rounded-full bg-paper-deep text-2xl font-bold"
      >
        −
      </button>
      <span className="w-12 text-center text-2xl font-extrabold">{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        className="pressable flex h-12 w-12 items-center justify-center rounded-full bg-paper-deep text-2xl font-bold"
      >
        +
      </button>
    </div>
  )
}

const WEEKDAY_SHORT = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
type ScheduleKind = 'daily' | 'weekly' | 'once'

function scheduleOf(recurrence: RecurrenceInput | null): ScheduleKind {
  if (!recurrence) return 'once'
  return recurrence.freq === 'weekly' ? 'weekly' : 'daily'
}

function ChoresTab() {
  const { data: people = [] } = usePeople()
  const { data: chores = [] } = useChores()
  const { data: rewards = [] } = useRewards()
  const { data: redemptions = [] } = useRedemptions()
  const choreMutations = useChoreMutations()
  const rewardMutations = useRewardMutations()
  const peopleById = new Map(people.map((p) => [p.id, p]))

  const [editingChore, setEditingChore] = useState<ChoreDto | 'new' | null>(null)
  const [choreTitle, setChoreTitle] = useState('')
  const [chorePerson, setChorePerson] = useState<string | null>(null)
  const [choreRotation, setChoreRotation] = useState<string[]>([])
  const [choreStars, setChoreStars] = useState(1)
  const [schedule, setSchedule] = useState<ScheduleKind>('daily')
  const [weekdays, setWeekdays] = useState<number[]>([])
  const [routine, setRoutine] = useState<'any' | 'morning' | 'evening'>('any')

  const [editingReward, setEditingReward] = useState<RewardDto | 'new' | null>(null)
  const [rewardTitle, setRewardTitle] = useState('')
  const [rewardCost, setRewardCost] = useState(10)

  const openChoreEditor = (c: ChoreDto | 'new'): void => {
    setEditingChore(c)
    if (c === 'new') {
      setChoreTitle('')
      setChorePerson(people[0]?.id ?? null)
      setChoreStars(1)
      setSchedule('daily')
      setWeekdays([])
      setRoutine('any')
      setChoreRotation([])
    } else {
      setChoreTitle(c.title)
      setChorePerson(c.personId)
      setChoreRotation(c.rotationPersonIds ?? [])
      setChoreStars(c.starsValue)
      setSchedule(scheduleOf(c.recurrence))
      setWeekdays(c.recurrence?.byWeekdays ?? [])
      setRoutine(c.routine ?? 'any')
    }
  }

  const saveChore = (): void => {
    if (!choreTitle.trim() || !chorePerson) return
    const recurrence: RecurrenceInput | null =
      schedule === 'once'
        ? null
        : schedule === 'daily'
          ? { freq: 'daily' }
          : { freq: 'weekly', byWeekdays: weekdays.length > 0 ? weekdays : [0] }
    const common = {
      title: choreTitle.trim(),
      personId: chorePerson,
      rotationPersonIds: choreRotation.length >= 2 ? choreRotation : [],
      starsValue: choreStars,
      recurrence,
      routine: routine === 'any' ? null : routine
    }
    if (editingChore === 'new') choreMutations.create.mutate(common)
    else if (editingChore) choreMutations.update.mutate({ id: editingChore.id, ...common })
    setEditingChore(null)
  }

  const saveReward = (): void => {
    if (!rewardTitle.trim()) return
    if (editingReward === 'new') rewardMutations.create.mutate({ title: rewardTitle.trim(), costStars: rewardCost })
    else if (editingReward) rewardMutations.update.mutate({ id: editingReward.id, title: rewardTitle.trim(), costStars: rewardCost })
    setEditingReward(null)
  }

  return (
    <div className="flex flex-col gap-6">
      {redemptions.length > 0 && (
        <div>
          <FieldLabel>Waiting for approval</FieldLabel>
          <div className="flex flex-col gap-2">
            {redemptions.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-2xl bg-sun-soft p-3">
                <span className="min-w-0 flex-1 truncate text-lg font-bold">
                  {peopleById.get(r.personId)?.name ?? 'Someone'} → {r.rewardTitle}
                </span>
                <span className="text-base font-extrabold text-ember-deep">★ {r.starsSpent}</span>
                <BigButton onClick={() => rewardMutations.grant.mutate({ redemptionId: r.id })}>Grant</BigButton>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <FieldLabel>Chores & routines</FieldLabel>
        <div className="flex flex-col gap-2">
          {chores.map((c) => {
            const person = peopleById.get(c.personId)
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => openChoreEditor(c)}
                className="pressable flex items-center gap-3 rounded-2xl bg-paper-deep/50 p-3 text-left"
              >
                <span className="h-6 w-6 shrink-0 rounded-full" style={{ backgroundColor: person?.color ?? '#999' }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg font-bold">{c.title}</span>
                  <span className="block text-sm font-bold text-ink-faint">
                    {person?.name ?? '—'} · {c.recurrence ? describeRecurrence(c.recurrence) : 'One time'}
                    {c.routine ? ` · ${c.routine}` : ''}
                  </span>
                </span>
                {c.starsValue > 0 && <span className="text-base font-extrabold text-ember-deep">★ {c.starsValue}</span>}
              </button>
            )
          })}
          <BigButton variant="ghost" onClick={() => openChoreEditor('new')} disabled={people.length === 0}>
            <span className="flex items-center justify-center gap-2">
              <PlusIcon size={20} /> Add chore
            </span>
          </BigButton>
          {people.length === 0 && (
            <p className="text-sm font-semibold text-ink-faint">Add family members first — chores belong to a person.</p>
          )}
        </div>
      </div>

      <div>
        <FieldLabel>Rewards</FieldLabel>
        <div className="flex flex-col gap-2">
          {rewards.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                setEditingReward(r)
                setRewardTitle(r.title)
                setRewardCost(r.costStars)
              }}
              className="pressable flex items-center gap-3 rounded-2xl bg-paper-deep/50 p-3 text-left"
            >
              <span className="min-w-0 flex-1 truncate text-lg font-bold">{r.title}</span>
              <span className="text-base font-extrabold text-ember-deep">★ {r.costStars}</span>
            </button>
          ))}
          <BigButton
            variant="ghost"
            onClick={() => {
              setEditingReward('new')
              setRewardTitle('')
              setRewardCost(10)
            }}
          >
            <span className="flex items-center justify-center gap-2">
              <PlusIcon size={20} /> Add reward
            </span>
          </BigButton>
        </div>
      </div>

      <Dialog
        open={editingChore !== null}
        onClose={() => setEditingChore(null)}
        title={editingChore === 'new' ? 'Add chore' : 'Edit chore'}
      >
        <div className="flex flex-col gap-4">
          <div>
            <FieldLabel>Chore</FieldLabel>
            <OskInput value={choreTitle} onChange={setChoreTitle} placeholder="e.g. Make your bed" autoFocus={editingChore === 'new'} />
          </div>
          <div>
            <FieldLabel>Who</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {people.map((p) => {
                const on = chorePerson === p.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setChorePerson(p.id)}
                    className={`pressable rounded-full border-2 px-4 py-2 text-base font-bold ${
                      on ? 'border-transparent' : 'border-line bg-card text-ink-soft'
                    }`}
                    style={on ? { backgroundColor: p.color, color: textOn(p.color) } : undefined}
                  >
                    {p.name}
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <FieldLabel>Rotate between (optional)</FieldLabel>
            <p className="mb-2 text-sm font-semibold text-ink-faint">
              Pick 2+ people to alternate this chore weekly — overrides "Who".
            </p>
            <div className="flex flex-wrap gap-2">
              {people.map((p) => {
                const on = choreRotation.includes(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() =>
                      setChoreRotation((prev) =>
                        prev.includes(p.id) ? prev.filter((id) => id !== p.id) : [...prev, p.id]
                      )
                    }
                    aria-pressed={on}
                    className={`pressable rounded-full border-2 px-4 py-2 text-base font-bold ${
                      on ? 'border-transparent' : 'border-line bg-card text-ink-soft'
                    }`}
                    style={on ? { backgroundColor: p.color, color: textOn(p.color) } : undefined}
                  >
                    {p.name}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex items-end gap-6">
            <div>
              <FieldLabel>Stars</FieldLabel>
              <Stepper value={choreStars} onChange={setChoreStars} max={20} />
            </div>
            <div className="flex-1">
              <FieldLabel>Routine</FieldLabel>
              <SegmentedControl
                value={routine}
                onChange={setRoutine}
                options={[
                  { value: 'any', label: 'Anytime' },
                  { value: 'morning', label: 'Morning' },
                  { value: 'evening', label: 'Evening' }
                ]}
              />
            </div>
          </div>
          <div>
            <FieldLabel>Repeats</FieldLabel>
            <SegmentedControl
              value={schedule}
              onChange={setSchedule}
              options={[
                { value: 'daily', label: 'Every day' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'once', label: 'One time' }
              ]}
            />
            {schedule === 'weekly' && (
              <div className="mt-3 flex gap-2">
                {WEEKDAY_SHORT.map((label, i) => {
                  const on = weekdays.includes(i)
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setWeekdays(on ? weekdays.filter((d) => d !== i) : [...weekdays, i])}
                      className={`pressable flex h-11 w-11 items-center justify-center rounded-full text-base font-extrabold ${
                        on ? 'bg-ember text-white' : 'bg-paper-deep text-ink-soft'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <div className="mt-1 flex gap-3">
            {editingChore !== 'new' && editingChore && (
              <BigButton
                variant="danger"
                onClick={() => {
                  choreMutations.remove.mutate({ id: editingChore.id })
                  setEditingChore(null)
                }}
              >
                Delete
              </BigButton>
            )}
            <div className="flex-1" />
            <BigButton variant="ghost" onClick={() => setEditingChore(null)}>
              Cancel
            </BigButton>
            <BigButton onClick={saveChore} disabled={!choreTitle.trim() || !chorePerson}>
              Save
            </BigButton>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={editingReward !== null}
        onClose={() => setEditingReward(null)}
        title={editingReward === 'new' ? 'Add reward' : 'Edit reward'}
      >
        <div className="flex flex-col gap-4">
          <div>
            <FieldLabel>Reward</FieldLabel>
            <OskInput value={rewardTitle} onChange={setRewardTitle} placeholder="e.g. Movie night pick" autoFocus={editingReward === 'new'} />
          </div>
          <div>
            <FieldLabel>Cost in stars</FieldLabel>
            <Stepper value={rewardCost} onChange={setRewardCost} min={1} max={999} />
          </div>
          <div className="mt-1 flex gap-3">
            {editingReward !== 'new' && editingReward && (
              <BigButton
                variant="danger"
                onClick={() => {
                  rewardMutations.remove.mutate({ id: editingReward.id })
                  setEditingReward(null)
                }}
              >
                Delete
              </BigButton>
            )}
            <div className="flex-1" />
            <BigButton variant="ghost" onClick={() => setEditingReward(null)}>
              Cancel
            </BigButton>
            <BigButton onClick={saveReward} disabled={!rewardTitle.trim()}>
              Save
            </BigButton>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function WeatherSection() {
  const { data: settings } = useSettings()
  const mutation = useSettingsMutation()
  const search = useCitySearch()
  const [query, setQuery] = useState('')
  if (!settings) return null

  return (
    <div>
      <FieldLabel>Weather</FieldLabel>
      <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
        {settings.weather ? (
          <div className="flex items-center gap-3">
            <span className="flex-1 text-lg font-bold">{settings.weather.label}</span>
            <button
              type="button"
              onClick={() => mutation.mutate({ weather: null })}
              className="pressable rounded-full border-2 border-ember-soft px-4 py-1.5 text-sm font-bold text-ember-deep"
            >
              Remove
            </button>
          </div>
        ) : (
          <p className="text-base font-semibold text-ink-soft">Pick a location to show the forecast in the header.</p>
        )}
        <div className="flex gap-2">
          <OskInput value={query} onChange={setQuery} placeholder="Search city…" className="flex-1" />
          <BigButton variant="ghost" onClick={() => search.mutate(query)} disabled={query.trim().length < 2 || search.isPending}>
            Search
          </BigButton>
        </div>
        {search.data && (
          <div className="flex flex-col gap-1.5">
            {search.data.length === 0 && <p className="text-sm font-bold text-ink-faint">No places found</p>}
            {search.data.map((city) => (
              <button
                key={`${city.lat},${city.lon}`}
                type="button"
                onClick={() => {
                  mutation.mutate({ weather: city })
                  search.reset()
                  setQuery('')
                }}
                className="pressable rounded-xl bg-card px-4 py-2.5 text-left text-base font-bold hover:bg-sun-soft"
              >
                {city.label}
              </button>
            ))}
          </div>
        )}
        <div>
          <FieldLabel>Units</FieldLabel>
          <SegmentedControl
            value={settings.temperatureUnit}
            onChange={(temperatureUnit) => mutation.mutate({ temperatureUnit })}
            options={[
              { value: 'f', label: '°F' },
              { value: 'c', label: '°C' }
            ]}
          />
        </div>
      </div>
    </div>
  )
}

function ParentalLockSection() {
  const { data: auth } = useAuthStatus()
  const authMutations = useAuthMutations()
  const [step, setStep] = useState<null | 'new' | 'confirm'>(null)
  const [firstPin, setFirstPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (!auth) return null

  return (
    <div>
      <FieldLabel>Parental lock</FieldLabel>
      <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
        <p className="text-base font-semibold text-ink-soft">
          {auth.pinSet
            ? 'A PIN is required to open settings and manage calendars, people, and sync.'
            : 'Set a PIN so kids can use the calendar but not change settings.'}
        </p>
        <div className="flex gap-3">
          <BigButton
            variant="ghost"
            onClick={() => {
              setError(null)
              setStep('new')
            }}
          >
            {auth.pinSet ? 'Change PIN' : 'Set PIN'}
          </BigButton>
          {auth.pinSet && (
            <BigButton variant="danger" onClick={() => authMutations.setPin.mutate({ pin: null })}>
              Remove PIN
            </BigButton>
          )}
        </div>
      </div>

      <PinDialog
        open={step !== null}
        title={step === 'confirm' ? 'Enter it once more' : 'Choose a PIN (4–8 digits)'}
        error={error}
        onClose={() => setStep(null)}
        onSubmit={(pin) => {
          if (step === 'new') {
            setFirstPin(pin)
            setError(null)
            setStep('confirm')
          } else if (pin === firstPin) {
            authMutations.setPin.mutate({ pin })
            setStep(null)
          } else {
            setError("PINs didn't match — start again")
            setStep('new')
          }
        }}
      />
    </div>
  )
}

function CompanionSection() {
  const { data: settings } = useSettings()
  const mutation = useSettingsMutation()
  const { data: status } = useCompanionStatus()
  const companionMutations = useCompanionMutations()
  const [qr, setQr] = useState<{ url: string; dataUrl: string } | null>(null)
  const [portDraft, setPortDraft] = useState<string | null>(null)
  if (!settings) return null
  const companion = settings.companion

  const pair = async (): Promise<void> => {
    const { url } = await companionMutations.issueToken.mutateAsync(undefined)
    const dataUrl = await QRCode.toDataURL(url, { width: 480, margin: 1 })
    setQr({ url, dataUrl })
  }

  const draftPort = portDraft === null ? companion.port : Number(portDraft)
  const portValid = Number.isInteger(draftPort) && draftPort >= 1024 && draftPort <= 65535

  return (
    <div>
      <FieldLabel>Companion app</FieldLabel>
      <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
        <div className="flex items-center gap-3">
          <span className="flex-1 text-base font-semibold text-ink-soft">
            Let phones on your home Wi-Fi edit lists, meals, and chores
          </span>
          <Toggle
            checked={companion.enabled}
            onChange={(enabled) => mutation.mutate({ companion: { ...companion, enabled } })}
            label="Companion app"
          />
        </div>

        {companion.enabled && (
          <>
            <div className="flex items-center gap-3">
              <span className="text-base font-bold text-ink-soft">Port</span>
              <div className="w-28">
                <OskInput
                  value={portDraft ?? String(companion.port)}
                  onChange={(v) => setPortDraft(v.replace(/\D/g, '').slice(0, 5))}
                  placeholder="8420"
                />
              </div>
              {portDraft !== null && draftPort !== companion.port && (
                <BigButton
                  variant="ghost"
                  disabled={!portValid}
                  onClick={() => {
                    mutation.mutate({ companion: { ...companion, port: draftPort } })
                    setPortDraft(null)
                  }}
                >
                  Apply
                </BigButton>
              )}
              <span className="flex-1 text-right text-sm font-semibold text-ink-faint">
                {status?.running
                  ? `Serving${status.urls[0] ? ` at ${status.urls[0]}` : ''}`
                  : (status?.lastError ?? 'Starting…')}
              </span>
            </div>

            <div className="flex gap-3">
              <BigButton onClick={() => void pair()} disabled={!status?.running}>
                Pair a phone
              </BigButton>
              {(status?.pairedCount ?? 0) > 0 && (
                <BigButton variant="danger" onClick={() => companionMutations.unpairAll.mutate(undefined)}>
                  Unpair all devices ({status?.pairedCount})
                </BigButton>
              )}
            </div>
            <p className="text-sm font-semibold text-ink-faint">
              If phones can't connect, allow OpenSkyLight through Windows Firewall (Private networks).
            </p>
          </>
        )}
      </div>

      <Dialog open={qr !== null} onClose={() => setQr(null)} title="Scan with the phone's camera">
        {qr && (
          <div className="flex flex-col items-center gap-3">
            <img src={qr.dataUrl} alt="Pairing QR code" className="h-64 w-64 rounded-xl bg-white p-2" />
            <p className="max-w-sm text-center text-sm font-semibold break-all text-ink-faint">{qr.url}</p>
            {(status?.urls.length ?? 0) > 1 && (
              <p className="max-w-sm text-center text-xs font-semibold text-ink-faint">
                Wrong network? This computer is also reachable at{' '}
                {status?.urls.slice(1).map((u) => new URL(u).hostname).join(', ')}
              </p>
            )}
            <p className="max-w-sm text-center text-sm font-semibold text-ink-soft">
              Then use the phone browser's “Add to Home Screen” to keep it like an app. Each scan pairs one
              device — close this and pair again for the next phone.
            </p>
            <BigButton onClick={() => setQr(null)}>Done</BigButton>
          </div>
        )}
      </Dialog>
    </div>
  )
}

function minutesToHhMm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function hhMmToMinutes(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function BackupSection() {
  const queryClient = useQueryClient()
  const pushToast = useToasts((s) => s.push)
  const status = useQuery({
    queryKey: ['backupStatus'],
    queryFn: () => ipcInvoke('backup:getStatus', undefined)
  })
  const remote = useQuery({
    queryKey: ['backupRemote'],
    queryFn: () => ipcInvoke('backup:listRemote', undefined),
    staleTime: 60_000
  })
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: (_data, fn) => {
      void queryClient.invalidateQueries({ queryKey: ['backupStatus'] })
      void queryClient.invalidateQueries({ queryKey: ['backupRemote'] })
      void queryClient.invalidateQueries({ queryKey: ['people'] })
      void queryClient.invalidateQueries({ queryKey: ['calendars'] })
      void queryClient.invalidateQueries({ queryKey: ['occurrences'] })
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
      fn === undefined // no-op to keep ts happy about the unused arg
    },
    onError: (err: Error) => pushToast(err.message)
  })
  const st = status.data
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
      <FieldLabel>Backup &amp; restore</FieldLabel>
      <p className="text-sm font-semibold text-ink-faint">
        Backs up the whole family dataset (people, events, chores, stars, lists, meals,
        and settings) as one JSON file. Credentials are never included — re-enter them on
        a new system. Automatic backups go to your WebDAV photo folder (backups/
        subfolder) once a day when it's connected.
      </p>
      {st?.lastAutoBackupAt && (
        <p className="text-sm font-bold text-ink-faint">
          Last auto-backup: {new Date(st.lastAutoBackupAt).toLocaleString()}
          {st.lastAutoBackupError ? ` · error: ${st.lastAutoBackupError}` : ''}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <BigButton
          variant="ghost"
          onClick={() => run.mutate(() => ipcInvoke('backup:exportToFile', undefined))}
          disabled={run.isPending}
        >
          Save backup to a file
        </BigButton>
        <BigButton
          variant="ghost"
          onClick={() => run.mutate(() => ipcInvoke('backup:uploadNow', undefined))}
          disabled={run.isPending}
        >
          Back up to Nextcloud now
        </BigButton>
        <BigButton
          variant="ghost"
          onClick={() => run.mutate(() => ipcInvoke('backup:restoreFromFile', undefined))}
          disabled={run.isPending}
        >
          Restore from a file
        </BigButton>
      </div>
      {remote.data && remote.data.length > 0 && (
        <div>
          <span className="mb-1 block text-xs font-extrabold text-ink-faint">
            BACKUPS ON NEXTCLOUD (newest first, max 30)
          </span>
          <div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
            {remote.data.slice(0, 30).map((b) => (
              <div key={b.name} className="flex items-center gap-2 rounded-xl bg-card px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm font-bold">{b.name}</span>
                <span className="text-xs font-bold text-ink-faint">
                  {(b.size / 1024).toFixed(0)} KB
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Restore ${b.name}? This replaces all current data.`)) {
                      run.mutate(() => ipcInvoke('backup:restoreFromRemote', { name: b.name }))
                    }
                  }}
                  className="pressable rounded-lg bg-ember px-3 py-1 text-sm font-extrabold text-white"
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function DoorbellSection() {
  const queryClient = useQueryClient()
  const { data: cameras = [] } = useQuery({ queryKey: ['cameras'], queryFn: () => ipcInvoke('camera:list', undefined) })
  const status = useQuery({ queryKey: ['doorbellStatus'], queryFn: () => ipcInvoke('doorbell:getStatus', undefined) })
  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: ['doorbellStatus'] })
  const setCamera = useMutation({
    mutationFn: (input: { cameraId: string | null }) => ipcInvoke('doorbell:setCamera', input),
    onSuccess: refresh
  })
  const rotate = useMutation({
    mutationFn: () => ipcInvoke('doorbell:rotateToken', undefined),
    onSuccess: refresh
  })
  const st = status.data
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
      <FieldLabel>Doorbell</FieldLabel>
      <p className="text-sm font-semibold text-ink-faint">
        When your UniFi doorbell rings, this display chimes and shows the door camera
        full-screen. In UniFi Protect: Alarm Manager → create an alarm → activity "Ring" →
        custom webhook, and paste the URL below. Requires the companion server to be running.
      </p>
      <div>
        <span className="mb-1 block text-xs font-extrabold text-ink-faint">DOORBELL CAMERA</span>
        <select
          value={st?.cameraId ?? ''}
          onChange={(e) => setCamera.mutate({ cameraId: e.target.value || null })}
          className="min-h-11 w-full rounded-xl border-2 border-line bg-card px-3 text-base font-bold"
          aria-label="Doorbell camera"
        >
          <option value="">None</option>
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {st?.webhookUrl ? (
        <div>
          <span className="mb-1 block text-xs font-extrabold text-ink-faint">WEBHOOK URL (paste into Protect)</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-xl bg-card p-3 text-sm font-bold">
              {st.webhookUrl}
            </code>
            <BigButton variant="ghost" onClick={() => void navigator.clipboard?.writeText(st.webhookUrl!)}>
              Copy
            </BigButton>
          </div>
        </div>
      ) : (
        <p className="text-sm font-semibold text-ink-faint">
          Pick a camera to generate the webhook URL.
        </p>
      )}
      {st?.webhookUrl && (
        <BigButton variant="ghost" onClick={() => rotate.mutate(undefined)} disabled={rotate.isPending}>
          Rotate webhook URL (invalidates the old one)
        </BigButton>
      )}
    </div>
  )
}

function AiImportSection() {
  const queryClient = useQueryClient()
  const ai = useAiImport()
  const { data: calendars = [] } = useCalendars()
  const status = useQuery({ queryKey: ['aiStatus'], queryFn: () => ipcInvoke('ai:getStatus', undefined) })
  const [endpointUrl, setEndpointUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [drafts, setDrafts] = useState<AiEventDraft[] | null>(null)
  const writable = calendars.filter((c) => !c.readOnly)
  const pending = useQuery({
    queryKey: ['aiScanPending'],
    queryFn: () => ipcInvoke('aiScan:getPending', undefined),
    refetchInterval: 60_000
  })

  const attach = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,application/pdf'
    input.multiple = true
    input.onchange = async () => {
      const files = [...(input.files ?? [])].slice(0, 5 - images.length)
      const encoded: string[] = []
      for (const f of files) {
        const buf = await f.arrayBuffer()
        let bin = ''
        const bytes = new Uint8Array(buf)
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
        encoded.push(btoa(bin))
      }
      setImages((prev) => [...prev, ...encoded].slice(0, 5))
    }
    input.click()
  }

  const runImport = (): void => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    ai.importEvents.mutate(
      { text, images, tz },
      {
        onSuccess: (res) => {
          setDrafts(res.drafts)
          setText('')
          setImages([])
        }
      }
    )
  }

  const confirmDraft = (draft: AiEventDraft, keep: boolean): void => {
    if (!keep) {
      setDrafts((d) => (d ?? []).filter((x) => x !== draft))
      return
    }
    const cal = writable[0]
    if (!cal) return
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const start = draft.allDay
      ? new Date(`${draft.date}T00:00:00`).toISOString()
      : new Date(`${draft.date}T${draft.startTime}:00`).toISOString()
    const end = draft.allDay
      ? new Date(new Date(`${draft.date}T00:00:00`).getTime() + 86400000).toISOString()
      : draft.endTime
        ? new Date(`${draft.date}T${draft.endTime}:00`).toISOString()
        : new Date(new Date(`${draft.date}T${draft.startTime}:00`).getTime() + 3600000).toISOString()
    void ipcInvoke('events:create', {
      calendarId: cal.id,
      title: draft.title,
      location: draft.location,
      description: draft.description,
      start,
      end,
      tz: zone,
      allDay: draft.allDay,
      personIds: [],
      recurrence: draft.repeat ? { freq: draft.repeat } : null
    }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['occurrences'] })
      setDrafts((d) => (d ?? []).filter((x) => x !== draft))
    })
  }

  const st = status.data
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
      <FieldLabel>AI import</FieldLabel>
      {st?.configured ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold text-ink-faint">
            {st.endpointUrl} · model {st.model}
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste an email, schedule text, or add photos of flyers…"
            className="min-h-24 w-full rounded-xl border border-line bg-paper p-3 text-base font-semibold outline-none placeholder:text-ink-faint focus:border-ember"
          />
          <div className="flex items-center gap-3">
            <BigButton variant="ghost" onClick={attach} disabled={images.length >= 5}>
              Attach ({images.length}/5)
            </BigButton>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => ai.clearConfig.mutate(undefined)}
              className="pressable rounded-full border-2 border-ember-soft px-3 py-1 text-sm font-bold text-ember-deep"
            >
              Forget AI settings
            </button>
          </div>
          <BigButton
            onClick={runImport}
            disabled={(!text.trim() && images.length === 0) || ai.importEvents.isPending}
          >
            {ai.importEvents.isPending ? 'Thinking…' : 'Find events'}
          </BigButton>
          {ai.importEvents.isError && (
            <p className="text-sm font-bold text-ember-deep">{ai.importEvents.error.message}</p>
          )}
          {(pending.data ?? []).length > 0 && (
            <div className="rounded-xl bg-card p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex-1 text-sm font-extrabold text-ink-faint">
                  SCANNED FROM NEXTCLOUD ({(pending.data ?? []).reduce((n, p) => n + p.drafts.length, 0)} drafts)
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void ipcInvoke('aiScan:clear', undefined).then(() =>
                      queryClient.invalidateQueries({ queryKey: ['aiScanPending'] })
                    )
                  }}
                  className="pressable rounded-lg px-2 py-1 text-sm font-extrabold text-ink-faint"
                >
                  Clear all
                </button>
              </div>
              {(pending.data ?? []).map((batch, bi) =>
                batch.drafts.map((d, di) => (
                  <div key={`${bi}-${di}`} className="flex items-center gap-2 border-b border-line/60 py-1.5 last:border-0">
                    <span className="min-w-0 flex-1 truncate text-sm font-bold">
                      {d.title}
                      <span className="ml-2 text-xs font-bold text-ink-faint">{batch.source}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void ipcInvoke('events:create', {
                          calendarId: writable[0].id,
                          title: d.title,
                          location: d.location,
                          description: d.description,
                          start: d.allDay
                            ? new Date(`${d.date}T00:00:00`).toISOString()
                            : new Date(`${d.date}T${d.startTime}:00`).toISOString(),
                          end: d.allDay
                            ? new Date(new Date(`${d.date}T00:00:00`).getTime() + 86400000).toISOString()
                            : d.endTime
                              ? new Date(`${d.date}T${d.endTime}:00`).toISOString()
                              : new Date(new Date(`${d.date}T${d.startTime}:00`).getTime() + 3600000).toISOString(),
                          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                          allDay: d.allDay,
                          personIds: [],
                          recurrence: d.repeat ? { freq: d.repeat } : null
                        }).then(() => {
                          void ipcInvoke('aiScan:removeDraft', { batch: bi, index: di }).then(() => {
                            void queryClient.invalidateQueries({ queryKey: ['aiScanPending'] })
                          })
                          void queryClient.invalidateQueries({ queryKey: ['occurrences'] })
                        })
                      }}
                      disabled={writable.length === 0}
                      className="pressable rounded-lg bg-ember px-3 py-1 text-sm font-extrabold text-white disabled:opacity-40"
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void ipcInvoke('aiScan:removeDraft', { batch: bi, index: di }).then(() => {
                          void queryClient.invalidateQueries({ queryKey: ['aiScanPending'] })
                        })
                      }}
                      className="pressable rounded-lg bg-paper-deep px-3 py-1 text-sm font-extrabold text-ink-faint"
                    >
                      Discard
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-ink-faint">
            Any OpenAI-compatible endpoint works — your Mistral API key, or a LAN-hosted server
            (e.g. Ollama behind a reverse proxy). The key is stored encrypted on this device.
            Image and PDF inputs need a vision-capable model.
          </p>
          <OskInput value={endpointUrl} onChange={setEndpointUrl} placeholder="https://api.mistral.ai/v1/chat/completions" />
          <OskInput value={model} onChange={setModel} placeholder="Model (e.g. mistral-small-latest)" />
          <OskInput value={apiKey} onChange={setApiKey} placeholder="API key" />
          <BigButton
            onClick={() => ai.setConfig.mutate({ endpointUrl: endpointUrl.trim(), model: model.trim(), apiKey: apiKey.trim() })}
            disabled={!endpointUrl.trim() || !model.trim() || ai.setConfig.isPending}
          >
            {ai.setConfig.isPending ? 'Saving…' : 'Save AI settings'}
          </BigButton>
          {ai.setConfig.isError && <p className="text-sm font-bold text-ember-deep">{ai.setConfig.error.message}</p>}
        </div>
      )}

      <Dialog open={drafts !== null} onClose={() => setDrafts(null)} title="Review proposed events">
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          {(drafts ?? []).length === 0 && <p>Nothing left to review.</p>}
          {(drafts ?? []).map((d, i) => (
            <div key={i} className="rounded-2xl bg-paper-deep/50 p-3">
              <div className="text-lg font-bold">{d.title}</div>
              <div className="text-sm font-bold text-ink-faint">
                {d.date}
                {d.allDay ? ' · all day' : ` · ${d.startTime ?? ''}–${d.endTime ?? ''}`}
                {d.repeat ? ` · repeats ${d.repeat}` : ''}
                {d.location ? ` · ${d.location}` : ''}
              </div>
              {d.note && <div className="mt-1 text-sm font-semibold text-ember-deep">⚠ {d.note}</div>}
              <div className="mt-2 flex gap-2">
                <BigButton variant="ghost" onClick={() => confirmDraft(d, false)}>Discard</BigButton>
                <span className="flex-1" />
                <BigButton onClick={() => confirmDraft(d, true)} disabled={writable.length === 0}>
                  Add to calendar
                </BigButton>
              </div>
            </div>
          ))}
        </div>
      </Dialog>
    </div>
  )
}

function WebdavPhotosSection() {
  const queryClient = useQueryClient()
  const { data: settings } = useSettings()
  const webdav = useWebdavMutations()
  const status = useQuery({
    queryKey: ['webdavStatus'],
    queryFn: () => ipcInvoke('webdav:getStatus', undefined),
    refetchInterval: 30_000
  })
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  if (!settings) return null
  const st = status.data
  const connect = (): void => {
    webdav.connect.mutate(
      { url: url.trim(), username: username.trim(), password },
      {
        onSuccess: () => {
          setUrl('')
          setUsername('')
          setPassword('')
          void queryClient.invalidateQueries({ queryKey: ['webdavStatus'] })
        }
      }
    )
  }
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
      <div className="flex items-center gap-2">
        <FieldLabel>Photos from Nextcloud (WebDAV)</FieldLabel>
        <span className="flex-1" />
        {st?.configured && (
          <button
            type="button"
            onClick={() => {
              webdav.disconnect.mutate(undefined, {
                onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['webdavStatus'] })
              })
            }}
            className="pressable rounded-full border-2 border-ember-soft px-3 py-1 text-sm font-bold text-ember-deep"
          >
            Disconnect
          </button>
        )}
      </div>
      {st?.configured ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-ink-faint">
            {st.url} · {st.cachedCount} photo{st.cachedCount === 1 ? '' : 's'} on the display
            {st.lastSyncedAt ? ` · synced ${new Date(st.lastSyncedAt).toLocaleString()}` : ''}
          </p>
          {st.lastError && <p className="text-sm font-bold text-ember-deep">{st.lastError}</p>}
          <div>
            <BigButton
              variant="ghost"
              onClick={() => {
                webdav.syncNow.mutate(undefined, {
                  onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['webdavStatus'] })
                })
              }}
              disabled={webdav.syncNow.isPending}
            >
              {webdav.syncNow.isPending ? 'Syncing…' : 'Sync photos now'}
            </BigButton>
          </div>
          <p className="text-sm font-semibold text-ink-faint">
            Photos land on the screensaver automatically. The paired phone can add photos from its Calendar tab.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-ink-faint">
            Point the screensaver at a folder on your Nextcloud (e.g.
            https://cloud.example.com/remote.php/dav/files/user/Photos). Use an app password.
            The kiosk pulls new photos automatically; phones upload through this connection.
          </p>
          <OskInput value={url} onChange={setUrl} placeholder="https://cloud.example.com/remote.php/dav/files/alice/Photos" />
          <OskInput value={username} onChange={setUsername} placeholder="Username" />
          <OskInput value={password} onChange={setPassword} placeholder="App password" />
          <BigButton onClick={connect} disabled={!url.trim() || !username.trim() || !password || webdav.connect.isPending}>
            {webdav.connect.isPending ? 'Connecting…' : 'Connect photo folder'}
          </BigButton>
          {webdav.connect.isError && (
            <p className="text-sm font-bold text-ember-deep">{webdav.connect.error.message}</p>
          )}
        </div>
      )}
    </div>
  )
}

function ScreensaverSection() {
  const { data: settings } = useSettings()
  const mutation = useSettingsMutation()
  if (!settings) return null
  const ss = settings.screensaver

  const pickFolder = async (): Promise<void> => {
    await ipcInvoke('screensaver:pickFolder', undefined)
    // folder is stored main-side; refresh settings
    mutation.mutate({})
  }

  return (
    <div>
      <FieldLabel>Photo screensaver</FieldLabel>
      <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-base font-bold text-ink-soft">
            {ss.folder ?? 'No photo folder chosen'}
          </span>
          <button
            type="button"
            onClick={() => void pickFolder()}
            className="pressable rounded-full border-2 border-line bg-card px-4 py-1.5 text-sm font-bold text-ink-soft"
          >
            Choose folder
          </button>
        </div>
        <div className="flex items-end gap-6">
          <div>
            <FieldLabel>Starts after (minutes idle)</FieldLabel>
            <Stepper
              value={ss.idleMinutes}
              min={1}
              max={120}
              onChange={(idleMinutes) => mutation.mutate({ screensaver: { ...ss, idleMinutes } })}
            />
          </div>
          <div className="flex-1" />
          <BigButton
            variant="ghost"
            disabled={!ss.folder}
            onClick={() => void ipcInvoke('kiosk:previewScreensaver', undefined)}
          >
            Preview
          </BigButton>
        </div>
      </div>
    </div>
  )
}

function SleepSection() {
  const { data: settings } = useSettings()
  const mutation = useSettingsMutation()
  if (!settings) return null
  const sleep = settings.sleep
  return (
    <div>
      <FieldLabel>Sleep schedule</FieldLabel>
      <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
        <div className="flex items-center gap-3">
          <span className="flex-1 text-base font-semibold text-ink-soft">
            Turn the screen dark overnight; tap to wake.
          </span>
          <Toggle checked={sleep.enabled} onChange={(enabled) => mutation.mutate({ sleep: { ...sleep, enabled } })} label="Sleep mode" />
        </div>
        {sleep.enabled && (
          <div className="grid grid-cols-2 gap-4">
            <TimeField
              label="Sleep at"
              minutes={hhMmToMinutes(sleep.start)}
              timeFormat={settings.timeFormat}
              onChange={(m) => mutation.mutate({ sleep: { ...sleep, start: minutesToHhMm(m) } })}
            />
            <TimeField
              label="Wake at"
              minutes={hhMmToMinutes(sleep.end)}
              timeFormat={settings.timeFormat}
              onChange={(m) => mutation.mutate({ sleep: { ...sleep, end: minutesToHhMm(m) } })}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function NightDimmingSection() {
  const { data: settings } = useSettings()
  const mutation = useSettingsMutation()
  if (!settings) return null
  const nd = settings.nightDimming
  return (
    <div>
      <FieldLabel>Night dimming</FieldLabel>
      <div className="flex flex-col gap-3 rounded-2xl bg-paper-deep/50 p-4">
        <div className="flex items-center gap-3">
          <span className="flex-1 text-base font-semibold text-ink-soft">
            Dim the screen during these hours — softer than full sleep, still readable.
          </span>
          <Toggle checked={nd.enabled} onChange={(enabled) => mutation.mutate({ nightDimming: { ...nd, enabled } })} label="Night dimming" />
        </div>
        {nd.enabled && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <TimeField
                label="Dim at"
                minutes={hhMmToMinutes(nd.start)}
                timeFormat={settings.timeFormat}
                onChange={(m) => mutation.mutate({ nightDimming: { ...nd, start: minutesToHhMm(m) } })}
              />
              <TimeField
                label="Brighten at"
                minutes={hhMmToMinutes(nd.end)}
                timeFormat={settings.timeFormat}
                onChange={(m) => mutation.mutate({ nightDimming: { ...nd, end: minutesToHhMm(m) } })}
              />
            </div>
            <div>
              <FieldLabel>Brightness ({nd.level}%)</FieldLabel>
              <input
                type="range"
                min={10}
                max={90}
                step={5}
                value={nd.level}
                onChange={(e) => mutation.mutate({ nightDimming: { ...nd, level: Number(e.target.value) } })}
                className="w-full accent-[var(--color-ember)]"
                aria-label="Dimming level"
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function GeneralTab() {
  const { data: settings } = useSettings()
  const mutation = useSettingsMutation()
  if (!settings) return null
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div>
        <FieldLabel>Appearance</FieldLabel>
        <SegmentedControl
          value={settings.theme}
          onChange={(theme) => mutation.mutate({ theme })}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'auto', label: 'Sunset to sunrise' }
          ]}
        />
        {settings.theme === 'auto' && (
          <p className="mt-2 text-sm font-semibold text-ink-faint">
            {settings.weather
              ? `Sun times computed for ${settings.weather.label}.`
              : 'No location set — using 7:00 pm to 7:00 am. Pick a weather location below for real sun times.'}
          </p>
        )}
      </div>
      <WeatherSection />
      <ScreensaverSection />
      <WebdavPhotosSection />
      <AiImportSection />
      <DoorbellSection />
      <BackupSection />
      <SleepSection />
      <NightDimmingSection />
      <ParentalLockSection />
      <CompanionSection />
      <div>
        <FieldLabel>Default screen</FieldLabel>
        <SegmentedControl
          value={settings.defaultView === 'home' ? 'home' : 'week'}
          onChange={(defaultView) => mutation.mutate({ defaultView })}
          options={[
            { value: 'home', label: 'Home' },
            { value: 'week', label: 'Week' }
          ]}
        />
      </div>
      <div>
        <FieldLabel>Week starts on</FieldLabel>
        <SegmentedControl
          value={String(settings.weekStartsOn) as '0' | '1'}
          onChange={(v) => mutation.mutate({ weekStartsOn: Number(v) as 0 | 1 })}
          options={[
            { value: '0', label: 'Sunday' },
            { value: '1', label: 'Monday' }
          ]}
        />
      </div>
      <div>
        <FieldLabel>Calendar sync interval</FieldLabel>
        <SegmentedControl
          value={String(settings.syncIntervalMinutes) as '5' | '15' | '30' | '60'}
          onChange={(v) => mutation.mutate({ syncIntervalMinutes: Number(v) })}
          options={[
            { value: '5', label: '5 min' },
            { value: '15', label: '15 min' },
            { value: '30', label: '30 min' },
            { value: '60', label: '1 hour' }
          ]}
        />
      </div>
      <div>
        <FieldLabel>Time format</FieldLabel>
        <SegmentedControl
          value={settings.timeFormat}
          onChange={(timeFormat) => mutation.mutate({ timeFormat })}
          options={[
            { value: '12h', label: '12-hour' },
            { value: '24h', label: '24-hour' }
          ]}
        />
      </div>
      <div className="flex items-center gap-3 rounded-2xl bg-paper-deep/50 p-4">
        <span className="flex-1 text-base font-semibold text-ink-soft">
          Launch OpenSkyLight when the computer starts (installed app only)
        </span>
        <Toggle
          checked={settings.launchOnStartup}
          onChange={(launchOnStartup) => mutation.mutate({ launchOnStartup })}
          label="Launch on startup"
        />
      </div>
    </div>
  )
}
