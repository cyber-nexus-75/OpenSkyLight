import { useEffect, useRef, useState } from 'react'
import type { PantryItemDto, ReceiptScanDto, ReceiptScanResultDto, ShoppingItemDto } from '@shared/types'
import type { ParsedReceiptItem } from '@shared/groceries/receiptParse'
import { normalizeItemName, parseSpokenItem } from '@shared/groceries/normalize'
import { parseVoiceCommand, type VoiceCommand } from '@shared/groceries/voice'
import { frysSearchUrl } from '@shared/groceries/frys'
import { useGroceries, useGroceriesMutations, useReceipts, useSettings } from '../../api/hooks'
import { ipcInvoke } from '../../api/client'
import { useToasts } from '../../stores/toastStore'
import { BigButton, Dialog, FieldLabel, IconButton, SegmentedControl } from '../../components/ui'
import { OskInput } from '../../components/Osk'
import {
  CameraIcon,
  CheckIcon,
  MicIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  ReceiptIcon,
  SearchIcon,
  TrashIcon,
  XIcon
} from '../../components/icons'
import { createVoiceController } from '../../lib/voice'
import { local } from '../../lib/format'

function formatQty(q: number): string {
  return Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100)
}

function itemLabel(name: string, quantity: number, unit: string | null): string {
  return `${formatQty(quantity)}${unit ? ` ${unit}` : ''} ${name}`.trim()
}

/** Downscale any image blob to a JPEG base64 payload (no data: prefix) for IPC/upload. */
async function imageBlobToBase64(blob: Blob, maxDim = 1800): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
  } finally {
    bitmap.close()
  }
}

function CameraModal({ onCapture, onClose }: { onCapture: (base64: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [cameraError, setCameraError] = useState(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        if (videoRef.current) videoRef.current.srcObject = s
      })
      .catch(() => setCameraError(true))
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const capture = (): void => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1800 / Math.max(video.videoWidth, video.videoHeight))
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    onCapture(canvas.toDataURL('image/jpeg', 0.85).split(',')[1])
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return
    onCapture(await imageBlobToBase64(file))
  }

  return (
    <Dialog open onClose={onClose} title="Scan receipt">
      <div className="flex flex-col gap-3">
        {cameraError ? (
          <p className="text-base font-semibold text-ink-soft">No camera on this device — pick a photo of the receipt instead.</p>
        ) : (
          <video ref={videoRef} autoPlay playsInline muted className="max-h-[45vh] w-full rounded-2xl bg-ink/80 object-contain" />
        )}
        <div className="flex gap-3">
          {!cameraError && (
            <BigButton onClick={capture} className="flex-1">
              <span className="flex items-center justify-center gap-2">
                <CameraIcon size={22} /> Capture
              </span>
            </BigButton>
          )}
          <label className="pressable flex min-h-14 flex-1 cursor-pointer items-center justify-center rounded-2xl bg-paper-deep px-6 text-lg font-bold text-ink hover:bg-line">
            <input type="file" accept="image/*" className="hidden" onChange={onFile} />
            Pick photo…
          </label>
        </div>
        <BigButton variant="ghost" onClick={onClose}>
          Cancel
        </BigButton>
      </div>
    </Dialog>
  )
}

function OrderTab({
  shopping,
  lowStock,
  storeBaseUrl,
  onScan
}: {
  shopping: ShoppingItemDto[]
  lowStock: PantryItemDto[]
  storeBaseUrl: string
  onScan: () => void
}) {
  const mutations = useGroceriesMutations()
  const pushToast = useToasts((s) => s.push)
  const [text, setText] = useState('')

  const add = (): void => {
    const t = text.trim()
    if (!t) return
    const q = parseSpokenItem(t)
    mutations.shoppingAdd.mutate({ name: q.rest, quantity: q.quantity, unit: q.unit }, { onSuccess: () => setText('') })
  }

  const unchecked = shopping.filter((i) => !i.checked)
  const checked = shopping.filter((i) => i.checked)
  const copy = (format: 'text' | 'csv'): void => {
    mutations.copyList.mutate(format, {
      onSuccess: () => pushToast(`Copied ${unchecked.length} item${unchecked.length === 1 ? '' : 's'} as ${format.toUpperCase()}`)
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2">
        <BigButton
          onClick={() =>
            mutations.addLowStock.mutate(undefined, {
              onSuccess: (res) => pushToast(res.added > 0 ? `Added ${res.added} low-stock item${res.added === 1 ? '' : 's'} to the order` : 'Nothing low right now')
            })
          }
        >
          Add low stock{lowStock.length > 0 ? ` (${lowStock.length})` : ''}
        </BigButton>
        <BigButton variant="ghost" onClick={() => copy('text')}>
          Copy list
        </BigButton>
        <BigButton variant="ghost" onClick={() => copy('csv')}>
          Copy CSV
        </BigButton>
        <BigButton variant="ghost" onClick={() => mutations.openFrys.mutate(undefined)}>
          <span className="flex items-center gap-2">
            <SearchIcon size={20} /> Open store
          </span>
        </BigButton>
        <BigButton variant="ghost" onClick={onScan}>
          <span className="flex items-center gap-2">
            <ReceiptIcon size={20} /> Scan receipt
          </span>
        </BigButton>
        {checked.length > 0 && (
          <BigButton variant="ghost" onClick={() => mutations.shoppingClear.mutate(undefined)}>
            Clear {checked.length} done
          </BigButton>
        )}
      </div>

      {lowStock.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-2xl bg-ember-soft/60 px-3 py-2">
          <span className="text-sm font-extrabold text-ember-deep">LOW:</span>
          {lowStock.map((p) => (
            <span key={p.id} className="rounded-full bg-card px-2.5 py-1 text-sm font-bold text-ink-soft shadow-card">
              {p.name} ({formatQty(p.quantity)}
              {p.unit ? ` ${p.unit}` : ''})
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <OskInput value={text} onChange={setText} placeholder="Add to the order — e.g. “2 gallons milk”…" className="min-h-12 text-base" />
        <button
          type="button"
          onClick={add}
          disabled={!text.trim()}
          className="pressable flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ember text-white disabled:opacity-30"
          aria-label="Add to order"
        >
          <PlusIcon size={22} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        {unchecked.map((item) => (
          <ShoppingRow key={item.id} item={item} storeBaseUrl={storeBaseUrl} />
        ))}
        {unchecked.length === 0 && (
          <p className="px-1 py-3 text-base font-semibold text-ink-faint">
            The order is empty — add items above, by voice (“add eggs”), or from low stock.
          </p>
        )}
        {checked.map((item) => (
          <ShoppingRow key={item.id} item={item} storeBaseUrl={storeBaseUrl} />
        ))}
      </div>
    </div>
  )
}

function ShoppingRow({ item, storeBaseUrl }: { item: ShoppingItemDto; storeBaseUrl: string }) {
  const mutations = useGroceriesMutations()
  return (
    <div className="group flex items-center gap-2.5 rounded-2xl bg-card px-3 py-2 shadow-card">
      <button
        type="button"
        onClick={() => mutations.shoppingToggle.mutate({ id: item.id })}
        className="pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-[2.5px] border-ember"
        style={{ backgroundColor: item.checked ? '#F76B15' : 'transparent' }}
        aria-label={item.checked ? 'Uncheck' : 'Check'}
      >
        {item.checked && <CheckIcon size={20} className="text-white" />}
      </button>
      <span className={`min-w-0 flex-1 text-lg font-semibold ${item.checked ? 'text-ink-faint line-through' : ''}`}>
        {itemLabel(item.name, item.quantity, item.unit)}
        {item.note && <span className="ml-2 text-sm font-semibold text-ink-faint">({item.note})</span>}
      </span>
      <a
        href={frysSearchUrl(storeBaseUrl, item.name)}
        target="_blank"
        rel="noreferrer"
        className="pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-paper-deep"
        aria-label={`Search ${item.name} on the store site`}
        title="Search on store site"
      >
        <SearchIcon size={20} />
      </a>
      <button
        type="button"
        onClick={() => mutations.shoppingRemove.mutate({ id: item.id })}
        className="pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-paper-deep"
        aria-label="Remove item"
      >
        <XIcon size={18} />
      </button>
    </div>
  )
}

function PantryTab({ pantry }: { pantry: PantryItemDto[] }) {
  const mutations = useGroceriesMutations()
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<PantryItemDto | null>(null)

  const add = (): void => {
    const t = text.trim()
    if (!t) return
    const q = parseSpokenItem(t)
    mutations.pantryAdd.mutate({ name: q.rest, quantity: q.quantity, unit: q.unit }, { onSuccess: () => setText('') })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex items-center gap-2">
        <OskInput value={text} onChange={setText} placeholder="Add to pantry — e.g. “a dozen eggs”…" className="min-h-12 text-base" />
        <button
          type="button"
          onClick={add}
          disabled={!text.trim()}
          className="pressable flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ember text-white disabled:opacity-30"
          aria-label="Add to pantry"
        >
          <PlusIcon size={22} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 min-[1500px]:grid-cols-3">
        {pantry.map((p) => {
          const low = p.quantity <= p.minQuantity
          return (
            <div key={p.id} className={`flex flex-col gap-1.5 rounded-card bg-card p-3.5 shadow-card ${low ? 'ring-2 ring-ember-soft' : ''}`}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-lg font-bold">{p.name}</span>
                {low && (
                  <span className="shrink-0 rounded-full bg-ember-soft px-2 py-0.5 text-xs font-extrabold text-ember-deep">LOW</span>
                )}
                <IconButton label={`Edit ${p.name}`} onClick={() => setEditing(p)} className="h-9 w-9">
                  <PencilIcon size={17} />
                </IconButton>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => mutations.pantryAdjust.mutate({ id: p.id, delta: -1 })}
                  className="pressable flex h-10 w-10 items-center justify-center rounded-full bg-paper-deep text-ink hover:bg-line"
                  aria-label="Use one"
                >
                  <MinusIcon size={18} />
                </button>
                <span className="min-w-16 text-center text-xl font-extrabold tabular-nums">
                  {formatQty(p.quantity)}
                  {p.unit ? ` ${p.unit}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => mutations.pantryAdjust.mutate({ id: p.id, delta: 1 })}
                  className="pressable flex h-10 w-10 items-center justify-center rounded-full bg-paper-deep text-ink hover:bg-line"
                  aria-label="Add one"
                >
                  <PlusIcon size={18} />
                </button>
                {p.minQuantity > 0 && <span className="ml-1 text-sm font-bold text-ink-faint">min {formatQty(p.minQuantity)}</span>}
              </div>
              {p.category && <span className="text-sm font-semibold text-ink-faint">{p.category}</span>}
            </div>
          )
        })}
        {pantry.length === 0 && (
          <p className="col-span-full px-1 py-3 text-base font-semibold text-ink-faint">
            Pantry is empty — scan a receipt or add what you have.
          </p>
        )}
      </div>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Edit ${editing.name}` : ''}>
        {editing && <PantryEditor item={editing} onClose={() => setEditing(null)} />}
      </Dialog>
    </div>
  )
}

function PantryEditor({ item, onClose }: { item: PantryItemDto; onClose: () => void }) {
  const mutations = useGroceriesMutations()
  const [name, setName] = useState(item.name)
  const [unit, setUnit] = useState(item.unit ?? '')
  const [category, setCategory] = useState(item.category ?? '')
  const [minQuantity, setMinQuantity] = useState(String(item.minQuantity))

  const save = (): void => {
    const min = Number(minQuantity)
    mutations.pantryUpdate.mutate(
      {
        id: item.id,
        name: name.trim(),
        unit: unit.trim() || null,
        category: category.trim() || null,
        minQuantity: Number.isFinite(min) ? Math.max(0, min) : 0
      },
      { onSuccess: onClose }
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <FieldLabel>Name</FieldLabel>
        <OskInput value={name} onChange={setName} autoFocus />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Unit</FieldLabel>
          <OskInput value={unit} onChange={setUnit} placeholder="e.g. lb, dozen" />
        </div>
        <div>
          <FieldLabel>Min (low-stock)</FieldLabel>
          <OskInput value={minQuantity} onChange={setMinQuantity} placeholder="0" />
        </div>
      </div>
      <div>
        <FieldLabel>Category</FieldLabel>
        <OskInput value={category} onChange={setCategory} placeholder="e.g. Dairy" />
      </div>
      <div className="mt-1 flex gap-3">
        <BigButton
          variant="danger"
          onClick={() => {
            mutations.pantryRemove.mutate({ id: item.id }, { onSuccess: onClose })
          }}
        >
          <span className="flex items-center gap-1.5">
            <TrashIcon size={18} /> Delete
          </span>
        </BigButton>
        <div className="flex-1" />
        <BigButton variant="ghost" onClick={onClose}>
          Cancel
        </BigButton>
        <BigButton onClick={save} disabled={!name.trim()}>
          Save
        </BigButton>
      </div>
    </div>
  )
}

interface EditableReceiptItem extends ParsedReceiptItem {
  included: boolean
}

function ReceiptReview({
  result,
  onApplied,
  onClose
}: {
  result: ReceiptScanResultDto
  onApplied: () => void
  onClose: () => void
}) {
  const mutations = useGroceriesMutations()
  const pushToast = useToasts((s) => s.push)
  const [items, setItems] = useState<EditableReceiptItem[]>(() => result.parsed.items.map((i) => ({ ...i, included: true })))

  const apply = (): void => {
    const selected = items.filter((i) => i.included && i.quantity > 0)
    mutations.applyReceipt.mutate(
      { scanId: result.scan.id, items: selected.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })) },
      {
        onSuccess: (res) => {
          pushToast(`Added ${res.updated} item${res.updated === 1 ? '' : 's'} to the pantry`)
          onApplied()
        }
      }
    )
  }

  return (
    <Dialog open onClose={onClose} title={result.parsed.store ? `Receipt — ${result.parsed.store}` : 'Receipt scan'}>
      <div className="flex flex-col gap-3">
        {result.parsed.total !== null && (
          <p className="text-base font-bold text-ink-soft">Total read: ${result.parsed.total.toFixed(2)}</p>
        )}
        <div className="flex max-h-[45vh] flex-col gap-1 overflow-y-auto">
          {items.map((item, idx) => (
            <div key={idx} className="flex items-center gap-2 rounded-xl bg-paper-deep/50 px-2 py-1.5">
              <button
                type="button"
                onClick={() => setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, included: !it.included } : it)))}
                className="pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-ember"
                style={{ backgroundColor: item.included ? '#F76B15' : 'transparent' }}
                aria-label={item.included ? 'Exclude item' : 'Include item'}
              >
                {item.included && <CheckIcon size={16} className="text-white" />}
              </button>
              <span className={`min-w-0 flex-1 truncate text-base font-semibold ${item.included ? '' : 'text-ink-faint line-through'}`}>
                {item.name}
              </span>
              <button
                type="button"
                className="pressable flex h-8 w-8 items-center justify-center rounded-full bg-card text-ink-soft"
                onClick={() => setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, quantity: Math.max(0, it.quantity - 1) } : it)))}
                aria-label="One less"
              >
                <MinusIcon size={14} />
              </button>
              <span className="min-w-8 text-center text-base font-extrabold tabular-nums">
                {formatQty(item.quantity)}
                {item.unit ? ` ${item.unit}` : ''}
              </span>
              <button
                type="button"
                className="pressable flex h-8 w-8 items-center justify-center rounded-full bg-card text-ink-soft"
                onClick={() => setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, quantity: it.quantity + 1 } : it)))}
                aria-label="One more"
              >
                <PlusIcon size={14} />
              </button>
              {item.price !== null && <span className="w-14 text-right text-sm font-bold text-ink-faint">${item.price.toFixed(2)}</span>}
            </div>
          ))}
          {items.length === 0 && <p className="py-2 text-base font-semibold text-ink-faint">No items recognized — check the photo and try again.</p>}
        </div>
        <div className="mt-1 flex gap-3">
          <div className="flex-1" />
          <BigButton variant="ghost" onClick={onClose}>
            Discard
          </BigButton>
          <BigButton onClick={apply} disabled={!items.some((i) => i.included)}>
            Add {items.filter((i) => i.included).length} to pantry
          </BigButton>
        </div>
      </div>
    </Dialog>
  )
}

function ReceiptsTab() {
  const { data: receipts = [] } = useReceipts()
  const mutations = useGroceriesMutations()
  const pushToast = useToasts((s) => s.push)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [pending, setPending] = useState<ReceiptScanResultDto | null>(null)
  const [viewing, setViewing] = useState<ReceiptScanResultDto | null>(null)
  const [viewingImage, setViewingImage] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  const scan = (base64: string): void => {
    setCameraOpen(false)
    setScanning(true)
    mutations.scanReceipt.mutate(base64, {
      onSuccess: (result) => {
        setPending(result)
        if (result.parsed.items.length === 0) pushToast('No items recognized — try a clearer photo')
      },
      onSettled: () => setScanning(false)
    })
  }

  const view = async (scan: ReceiptScanDto): Promise<void> => {
    try {
      const detail = await ipcInvoke('groceries:receiptDetail', { scanId: scan.id })
      setViewing({ scan: detail.scan, rawText: detail.rawText, parsed: detail.parsed })
      const img = await ipcInvoke('groceries:receiptImage', { scanId: scan.id })
      setViewingImage(img.dataUrl)
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Could not load scan')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex items-center gap-2">
        <BigButton onClick={() => setCameraOpen(true)} disabled={scanning}>
          <span className="flex items-center gap-2">
            <CameraIcon size={20} /> {scanning ? 'Scanning…' : 'Scan receipt'}
          </span>
        </BigButton>
        <span className="text-sm font-semibold text-ink-faint">Photos stay on this device — OCR runs locally.</span>
      </div>
      {receipts.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => void view(r)}
          className="pressable flex items-center gap-3 rounded-2xl bg-card px-4 py-3 text-left shadow-card"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-paper-deep text-ink-soft">
            <ReceiptIcon size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-lg font-bold">{r.store ?? 'Receipt'}</span>
            <span className="block text-sm font-semibold text-ink-faint">
              {local(r.scannedAt).toFormat('LLL d, h:mm a')} · {r.itemCount} item{r.itemCount === 1 ? '' : 's'}
              {r.total !== null ? ` · $${r.total.toFixed(2)}` : ''}
            </span>
          </span>
          {r.applied && <span className="rounded-full bg-paper-deep px-2.5 py-1 text-xs font-extrabold text-ink-soft">IN PANTRY</span>}
        </button>
      ))}
      {receipts.length === 0 && (
        <p className="px-1 py-3 text-base font-semibold text-ink-faint">No receipts scanned yet — snap one after shopping to update the pantry.</p>
      )}

      {cameraOpen && <CameraModal onCapture={scan} onClose={() => setCameraOpen(false)} />}
      {pending && (
        <ReceiptReview
          result={pending}
          onApplied={() => setPending(null)}
          onClose={() => setPending(null)}
        />
      )}
      {viewing && (
        <Dialog open onClose={() => { setViewing(null); setViewingImage(null) }} title={viewing.parsed.store ? `Receipt — ${viewing.parsed.store}` : 'Receipt'}>
          <div className="flex flex-col gap-3">
            {viewingImage && <img src={viewingImage} alt="Receipt" className="max-h-[30vh] w-full rounded-2xl object-contain" />}
            <div className="flex max-h-[35vh] flex-col gap-1 overflow-y-auto">
              {viewing.parsed.items.map((item, idx) => (
                <div key={idx} className="flex items-center gap-2 rounded-xl bg-paper-deep/50 px-2 py-1.5 text-base font-semibold">
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="font-extrabold tabular-nums">
                    {formatQty(item.quantity)}
                    {item.unit ? ` ${item.unit}` : ''}
                  </span>
                  {item.price !== null && <span className="w-14 text-right text-sm font-bold text-ink-faint">${item.price.toFixed(2)}</span>}
                </div>
              ))}
              {viewing.parsed.items.length === 0 && <p className="py-2 text-base font-semibold text-ink-faint">No items recognized.</p>}
            </div>
            <div className="mt-1 flex gap-3">
              {!viewing.scan.applied && (
                <BigButton
                  onClick={() => {
                    mutations.applyReceipt.mutate(
                      {
                        scanId: viewing.scan.id,
                        items: viewing.parsed.items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit }))
                      },
                      {
                        onSuccess: (res) => {
                          pushToast(`Added ${res.updated} items to the pantry`)
                          setViewing(null)
                          setViewingImage(null)
                        }
                      }
                    )
                  }}
                >
                  Add to pantry
                </BigButton>
              )}
              <div className="flex-1" />
              <BigButton variant="ghost" onClick={() => { setViewing(null); setViewingImage(null) }}>
                Close
              </BigButton>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}

export function GroceriesView() {
  const { data: state } = useGroceries()
  const { data: settings } = useSettings()
  const mutations = useGroceriesMutations()
  const pushToast = useToasts((s) => s.push)
  const [tab, setTab] = useState<'order' | 'pantry' | 'receipts'>('order')
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const voiceRef = useRef(createVoiceController())

  const pantry = state?.pantry ?? []
  const shopping = state?.shopping ?? []
  const lowStock = state?.lowStock ?? []
  const storeBaseUrl = settings?.groceries.storeBaseUrl ?? 'https://www.kroger.com'

  const runCommand = (cmd: VoiceCommand): void => {
    switch (cmd.type) {
      case 'addToList':
        mutations.shoppingAdd.mutate({ name: cmd.item, quantity: cmd.quantity, unit: cmd.unit })
        pushToast(`Added ${itemLabel(cmd.item, cmd.quantity, cmd.unit)} to the order`)
        break
      case 'outOf': {
        const key = normalizeItemName(cmd.item)
        const existing = pantry.find((p) => normalizeItemName(p.name) === key)
        if (existing) mutations.pantryUpdate.mutate({ id: existing.id, quantity: 0 })
        else mutations.pantryAdd.mutate({ name: cmd.item, quantity: 0, minQuantity: 1 })
        mutations.shoppingAdd.mutate({ name: cmd.item, quantity: 1, note: 'out' })
        pushToast(`Marked “${cmd.item}” as out and added it to the order`)
        break
      }
      case 'used': {
        const key = normalizeItemName(cmd.item)
        const existing = pantry.find((p) => normalizeItemName(p.name) === key)
        if (existing) {
          mutations.pantryAdjust.mutate({ id: existing.id, delta: -cmd.quantity })
          pushToast(`Used ${itemLabel(cmd.item, cmd.quantity, cmd.unit)} — ${existing.name} now ${formatQty(Math.max(0, existing.quantity - cmd.quantity))}`)
        } else pushToast(`No “${cmd.item}” in the pantry to use`)
        break
      }
      case 'bought':
        mutations.pantryAdd.mutate({ name: cmd.item, quantity: cmd.quantity, unit: cmd.unit })
        pushToast(`Pantry +${itemLabel(cmd.item, cmd.quantity, cmd.unit)}`)
        break
      case 'lowStock':
        setTab('pantry')
        pushToast(lowStock.length > 0 ? `Low: ${lowStock.map((p) => p.name).join(', ')}` : 'Nothing is low')
        break
      case 'pantryQuery':
        pushToast(`${pantry.length} pantry item${pantry.length === 1 ? '' : 's'}, ${lowStock.length} low`)
        setTab('pantry')
        break
      case 'shoppingQuery': {
        const open = shopping.filter((i) => !i.checked)
        pushToast(open.length > 0 ? `Order: ${open.map((i) => i.name).join(', ')}` : 'The order is empty')
        setTab('order')
        break
      }
      case 'prepareFrys':
        setTab('order')
        mutations.copyList.mutate('text', {
          onSuccess: () => pushToast(`${shopping.filter((i) => !i.checked).length} items copied — tap 🔍 on any item to search the store site`)
        })
        break
      case 'clearList':
        mutations.shoppingClear.mutate(undefined)
        pushToast('Cleared the done items')
        break
      case 'scanReceipt':
        setTab('receipts')
        pushToast('Tap “Scan receipt” on the Receipts tab')
        break
      case 'unknown':
        pushToast(`Didn't catch that: “${cmd.text}”`)
        break
    }
  }

  const toggleListening = (): void => {
    const voice = voiceRef.current
    if (!voice.supported) {
      pushToast('Voice input is not available in this browser')
      return
    }
    if (voice.listening) {
      voice.stop()
      setListening(false)
      return
    }
    setTranscript('')
    voice.start((text, isFinal) => {
      setTranscript(text)
      if (isFinal) {
        setListening(false)
        setTranscript('')
        runCommand(parseVoiceCommand(text))
      }
    })
    setListening(true)
  }

  return (
    <div className="flex h-full flex-col gap-3 px-6 pb-6">
      <div className="flex items-center gap-2">
        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={[
            { value: 'order', label: 'Order' },
            { value: 'pantry', label: 'Pantry' },
            { value: 'receipts', label: 'Receipts' }
          ]}
        />
        <div className="flex-1" />
        {listening && transcript && (
          <span className="max-w-72 truncate rounded-full bg-paper-deep px-3 py-1.5 text-sm font-bold text-ink-soft">“{transcript}”</span>
        )}
        <IconButton
          label={listening ? 'Stop listening' : 'Voice command'}
          onClick={toggleListening}
          className={listening ? 'bg-ember text-white hover:bg-ember-deep' : ''}
        >
          <MicIcon size={24} />
        </IconButton>
      </div>

      {tab === 'order' && (
        <OrderTab shopping={shopping} lowStock={lowStock} storeBaseUrl={storeBaseUrl} onScan={() => setTab('receipts')} />
      )}
      {tab === 'pantry' && <PantryTab pantry={pantry} />}
      {tab === 'receipts' && <ReceiptsTab />}
    </div>
  )
}
