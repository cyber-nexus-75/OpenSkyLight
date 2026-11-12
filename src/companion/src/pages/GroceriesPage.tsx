import { useRef, useState } from 'react'
import type { ReceiptScanResultDto } from '@shared/types'
import type { ParsedReceiptItem } from '@shared/groceries/receiptParse'
import { normalizeItemName, parseSpokenItem } from '@shared/groceries/normalize'
import { parseVoiceCommand, type VoiceCommand } from '@shared/groceries/voice'
import { DEFAULT_STORE_BASE_URL, frysSearchUrl, frysTextList } from '@shared/groceries/frys'
import { uploadReceipt } from '../api/client'
import { useGroceries, useGroceriesMutations, useReceipts } from '../api/hooks'
import { Card, CheckCircle, EmptyNote, GhostButton, PrimaryButton, SectionLabel, TextInput } from '../components/ui'

function formatQty(q: number): string {
  return Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100)
}

async function imageFileToJpegBytes(file: Blob, maxDim = 1800): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob) throw new Error('Could not encode photo')
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    bitmap.close()
  }
}

/** Minimal SpeechRecognition wrapper (same API surface as the kiosk's lib/voice). */
function useVoice(onCommand: (cmd: VoiceCommand) => void): { supported: boolean; listening: boolean; toggle: () => void; transcript: string } {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const recRef = useRef<{
    start: () => void
    stop: () => void
  } | null>(null)
  const supported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)

  const toggle = (): void => {
    if (listening) {
      try {
        recRef.current?.stop()
      } catch {
        // already stopped
      }
      setListening(false)
      return
    }
    const w = window as unknown as {
      SpeechRecognition?: new () => any
      webkitSpeechRecognition?: new () => any
    }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = navigator.language || 'en-US'
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (e: any) => {
      const last = e.results[e.results.length - 1]
      if (!last) return
      setTranscript(last[0]?.transcript ?? '')
      if (last.isFinal) {
        setListening(false)
        setTranscript('')
        onCommand(parseVoiceCommand(last[0]?.transcript ?? ''))
      }
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recRef.current = rec
    setTranscript('')
    setListening(true)
    rec.start()
  }

  return { supported, listening, toggle, transcript }
}

interface EditableItem extends ParsedReceiptItem {
  included: boolean
}

export function GroceriesPage() {
  const { data: state, isPending } = useGroceries()
  const { data: receipts = [] } = useReceipts()
  const mutations = useGroceriesMutations()
  const [note, setNote] = useState<string | null>(null)
  const [newItem, setNewItem] = useState('')
  const [scanning, setScanning] = useState(false)
  const [pending, setPending] = useState<ReceiptScanResultDto | null>(null)
  const [pendingItems, setPendingItems] = useState<EditableItem[]>([])

  const shopping = state?.shopping ?? []
  const pantry = state?.pantry ?? []
  const lowStock = state?.lowStock ?? []
  const unchecked = shopping.filter((i) => !i.checked)

  const flash = (msg: string): void => {
    setNote(msg)
    setTimeout(() => setNote(null), 4000)
  }

  const runCommand = (cmd: VoiceCommand): void => {
    switch (cmd.type) {
      case 'addToList': {
        const q = cmd
        mutations.shoppingAdd.mutate({ name: q.item, quantity: q.quantity, unit: q.unit })
        flash(`Added ${formatQty(q.quantity)}${q.unit ? ` ${q.unit}` : ''} ${q.item}`)
        break
      }
      case 'outOf': {
        const key = normalizeItemName(cmd.item)
        const existing = pantry.find((p) => normalizeItemName(p.name) === key)
        if (existing) mutations.pantryUpdate.mutate({ id: existing.id, quantity: 0 })
        else mutations.pantryAdd.mutate({ name: cmd.item, quantity: 0, minQuantity: 1 })
        mutations.shoppingAdd.mutate({ name: cmd.item, quantity: 1, note: 'out' })
        flash(`“${cmd.item}” marked out + added to the order`)
        break
      }
      case 'used': {
        const key = normalizeItemName(cmd.item)
        const existing = pantry.find((p) => normalizeItemName(p.name) === key)
        if (existing) {
          mutations.pantryAdjust.mutate({ id: existing.id, delta: -cmd.quantity })
          flash(`Used ${formatQty(cmd.quantity)} ${cmd.item}`)
        } else flash(`No “${cmd.item}” in the pantry`)
        break
      }
      case 'bought':
        mutations.pantryAdd.mutate({ name: cmd.item, quantity: cmd.quantity, unit: cmd.unit })
        flash(`Pantry +${formatQty(cmd.quantity)}${cmd.unit ? ` ${cmd.unit}` : ''} ${cmd.item}`)
        break
      case 'lowStock':
        flash(lowStock.length > 0 ? `Low: ${lowStock.map((p) => p.name).join(', ')}` : 'Nothing is low')
        break
      case 'pantryQuery':
        flash(`${pantry.length} pantry items, ${lowStock.length} low`)
        break
      case 'shoppingQuery':
        flash(unchecked.length > 0 ? `Order: ${unchecked.map((i) => i.name).join(', ')}` : 'Order is empty')
        break
      case 'prepareFrys':
        void navigator.clipboard
          ?.writeText(frysTextList(unchecked.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit }))))
          .then(() => flash('Order copied — open a 🔍 link to search the store'))
          .catch(() => flash('Could not copy'))
        break
      case 'clearList':
        mutations.shoppingClear.mutate(undefined)
        flash('Cleared done items')
        break
      case 'scanReceipt':
        flash('Use the Scan receipt button below')
        break
      case 'unknown':
        flash(`Didn't catch that: “${cmd.text}”`)
        break
    }
  }

  const voice = useVoice(runCommand)

  const addItem = (): void => {
    const t = newItem.trim()
    if (!t) return
    const q = parseSpokenItem(t)
    mutations.shoppingAdd.mutate({ name: q.rest, quantity: q.quantity, unit: q.unit })
    setNewItem('')
  }

  const onReceiptFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setScanning(true)
    try {
      const bytes = await imageFileToJpegBytes(file)
      const result = await uploadReceipt(bytes)
      setPending(result)
      setPendingItems(result.parsed.items.map((i) => ({ ...i, included: true })))
      if (result.parsed.items.length === 0) flash('No items recognized — try a clearer photo')
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setScanning(false)
    }
  }

  const applyPending = (): void => {
    if (!pending) return
    const items = pendingItems.filter((i) => i.included && i.quantity > 0)
    mutations.applyReceipt.mutate(
      { scanId: pending.scan.id, items: items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })) },
      {
        onSuccess: (res) => {
          flash(`Added ${res.updated} items to the pantry`)
          setPending(null)
        }
      }
    )
  }

  const copyOrder = (): void => {
    void navigator.clipboard
      ?.writeText(frysTextList(unchecked.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit }))))
      .then(() => flash('Order copied to clipboard'))
      .catch(() => flash('Could not copy'))
  }

  return (
    <div className="flex flex-col gap-4">
      {note && <div className="rounded-xl bg-sun-soft px-3 py-2 text-sm font-bold text-ink">{note}</div>}
      {isPending && <EmptyNote>Loading…</EmptyNote>}

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <SectionLabel>This week's order ({unchecked.length})</SectionLabel>
          <div className="flex-1" />
          {voice.supported && (
            <button
              type="button"
              onClick={voice.toggle}
              aria-label="Voice command"
              className={`pressable flex h-10 w-10 items-center justify-center rounded-full ${
                voice.listening ? 'bg-ember text-white' : 'bg-paper-deep text-ink-soft'
              }`}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <path d="M12 18v3" />
              </svg>
            </button>
          )}
        </div>
        {voice.listening && voice.transcript && (
          <p className="mb-2 truncate text-sm font-bold text-ink-soft">“{voice.transcript}”</p>
        )}
        {unchecked.length === 0 && shopping.length > 0 && <EmptyNote>Everything is checked off.</EmptyNote>}
        {unchecked.length === 0 && shopping.length === 0 && <EmptyNote>Order is empty — add something below.</EmptyNote>}
        <div className="flex flex-col gap-1">
          {unchecked.map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded-lg px-1 py-1">
              <CheckCircle checked={false} onTap={() => mutations.shoppingToggle.mutate({ id: item.id })} label={`Check ${item.name}`} />
              <span className="min-w-0 flex-1 text-base font-semibold">
                {formatQty(item.quantity)}
                {item.unit ? ` ${item.unit}` : ''} {item.name}
              </span>
              <a
                href={frysSearchUrl(DEFAULT_STORE_BASE_URL, item.name)}
                target="_blank"
                rel="noreferrer"
                className="pressable flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper-deep text-xs font-extrabold text-ink-soft"
                aria-label={`Search ${item.name} on the store site`}
              >
                🔍
              </a>
              <button
                type="button"
                onClick={() => mutations.shoppingRemove.mutate({ id: item.id })}
                className="pressable h-9 w-9 shrink-0 text-center text-lg font-bold text-ink-faint"
                aria-label={`Remove ${item.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            addItem()
          }}
        >
          <TextInput value={newItem} onChange={setNewItem} placeholder="Add — “2 gallons milk”…" />
          <PrimaryButton type="submit" disabled={!newItem.trim()}>
            Add
          </PrimaryButton>
        </form>
        <div className="mt-2 flex flex-wrap gap-2">
          <GhostButton
            onClick={() =>
              mutations.addLowStock.mutate(undefined, {
                onSuccess: (res) => flash(res.added > 0 ? `Added ${res.added} low-stock items` : 'Nothing low right now')
              })
            }
          >
            + Low stock{lowStock.length > 0 ? ` (${lowStock.length})` : ''}
          </GhostButton>
          <GhostButton onClick={copyOrder} disabled={unchecked.length === 0}>
            Copy order
          </GhostButton>
          {shopping.some((i) => i.checked) && (
            <GhostButton onClick={() => mutations.shoppingClear.mutate(undefined)}>Clear done</GhostButton>
          )}
        </div>
      </Card>

      <Card>
        <SectionLabel>Pantry ({pantry.length})</SectionLabel>
        {pantry.length === 0 && <EmptyNote>Scan a receipt to fill the pantry.</EmptyNote>}
        <div className="flex flex-col gap-1">
          {pantry.map((p) => {
            const low = p.quantity <= p.minQuantity
            return (
              <div key={p.id} className="flex items-center gap-2 rounded-lg px-1 py-1">
                <span className="min-w-0 flex-1 text-base font-semibold">
                  {p.name}
                  {low && <span className="ml-2 rounded-full bg-sun-soft px-2 py-0.5 text-xs font-extrabold text-ember-deep">LOW</span>}
                </span>
                <button
                  type="button"
                  onClick={() => mutations.pantryAdjust.mutate({ id: p.id, delta: -1 })}
                  className="pressable h-9 w-9 rounded-full bg-paper-deep text-lg font-extrabold text-ink-soft"
                  aria-label={`Use one ${p.name}`}
                >
                  −
                </button>
                <span className="min-w-12 text-center text-base font-extrabold tabular-nums">
                  {formatQty(p.quantity)}
                  {p.unit ? ` ${p.unit}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => mutations.pantryAdjust.mutate({ id: p.id, delta: 1 })}
                  className="pressable h-9 w-9 rounded-full bg-paper-deep text-lg font-extrabold text-ink-soft"
                  aria-label={`Add one ${p.name}`}
                >
                  +
                </button>
              </div>
            )
          })}
        </div>
      </Card>

      <Card>
        <SectionLabel>Receipts</SectionLabel>
        <label className="pressable flex min-h-12 cursor-pointer items-center justify-center rounded-xl bg-ember px-4 text-base font-extrabold text-white">
          <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onReceiptFile} />
          {scanning ? 'Scanning…' : '📷 Scan receipt'}
        </label>
        {receipts.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            {receipts.slice(0, 10).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() =>
                  mutations.receiptDetail.mutate(r.id, {
                    onSuccess: (detail) => {
                      setPending({ scan: detail.scan, rawText: detail.rawText, parsed: detail.parsed })
                      setPendingItems(detail.parsed.items.map((i) => ({ ...i, included: true })))
                    }
                  })
                }
                className="pressable rounded-lg bg-paper-deep/60 px-3 py-2 text-left text-sm font-bold text-ink-soft"
              >
                {r.store ?? 'Receipt'} · {r.itemCount} items{r.total !== null ? ` · $${r.total.toFixed(2)}` : ''}
                {r.applied ? ' · in pantry' : ''}
              </button>
            ))}
          </div>
        )}
      </Card>

      {pending && (
        <Card>
          <SectionLabel>{pending.parsed.store ? `Receipt — ${pending.parsed.store}` : 'Receipt scan'}</SectionLabel>
          {pending.parsed.total !== null && <p className="mb-2 text-sm font-bold">Total read: ${pending.parsed.total.toFixed(2)}</p>}
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {pendingItems.map((item, idx) => (
              <div key={idx} className="flex items-center gap-2 rounded-lg bg-paper-deep/50 px-2 py-1.5">
                <CheckCircle
                  checked={item.included}
                  onTap={() => setPendingItems((arr) => arr.map((it, i) => (i === idx ? { ...it, included: !it.included } : it)))}
                  label={item.included ? `Exclude ${item.name}` : `Include ${item.name}`}
                />
                <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${item.included ? '' : 'text-ink-faint line-through'}`}>
                  {item.name}
                </span>
                <span className="text-sm font-extrabold tabular-nums">
                  {formatQty(item.quantity)}
                  {item.unit ? ` ${item.unit}` : ''}
                </span>
              </div>
            ))}
            {pendingItems.length === 0 && <EmptyNote>No items recognized.</EmptyNote>}
          </div>
          <div className="mt-3 flex gap-2">
            <GhostButton onClick={() => setPending(null)}>Discard</GhostButton>
            <PrimaryButton onClick={applyPending} disabled={!pendingItems.some((i) => i.included)}>
              Add {pendingItems.filter((i) => i.included).length} to pantry
            </PrimaryButton>
          </div>
        </Card>
      )}
    </div>
  )
}
