import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { HomeTile, HomeTileType } from '@shared/types'
import { findFreeSpot, TILE_SPECS } from '@shared/home'
import { PRESET_FEEDS } from '@shared/rss'
import { uuidv7 } from '@shared/uuid'
import { ipcInvoke } from '../../api/client'
import { useLists } from '../../api/hooks'
import { useToasts } from '../../stores/toastStore'
import { BigButton, FieldLabel, Sheet } from '../../components/ui'
import { OskInput } from '../../components/Osk'
import { XIcon } from '../../components/icons'
import { TILE_REGISTRY } from './tileRegistry'

const TILE_TYPES = Object.keys(TILE_REGISTRY) as HomeTileType[]
type PickerStep = null | 'list' | 'news' | 'camera' | 'birdnet'

export function AddTileSheet({
  open,
  layout,
  onClose,
  onAdd
}: {
  open: boolean
  layout: HomeTile[]
  onClose: () => void
  onAdd: (tile: HomeTile) => void
}) {
  const { data: lists = [] } = useLists()
  const pushToast = useToasts((s) => s.push)
  const [picker, setPicker] = useState<PickerStep>(null)

  const place = (type: HomeTileType, config?: HomeTile['config']): void => {
    const spec = TILE_SPECS[type]
    const spot =
      findFreeSpot(layout, spec.defaultW, spec.defaultH) ?? findFreeSpot(layout, spec.minW, spec.minH)
    if (!spot) {
      pushToast('No room on the grid — remove or shrink a tile first')
      return
    }
    const fitsDefault = findFreeSpot(layout, spec.defaultW, spec.defaultH) !== null
    onAdd({
      id: uuidv7(),
      type,
      x: spot.x,
      y: spot.y,
      w: fitsDefault ? spec.defaultW : spec.minW,
      h: fitsDefault ? spec.defaultH : spec.minH,
      ...(config ? { config } : {})
    })
    setPicker(null)
    onClose()
  }

  const title =
    picker === 'list'
      ? 'Which list?'
      : picker === 'news'
        ? 'Which news feed?'
        : picker === 'camera'
          ? 'Which camera?'
          : picker === 'birdnet'
            ? 'BirdNET-Go address'
            : 'Add a tile'

  return (
    <Sheet
      open={open}
      onClose={() => {
        setPicker(null)
        onClose()
      }}
      title={title}
    >
      {picker === 'list' ? (
        <div className="flex flex-col gap-2 pb-2">
          {lists.length === 0 && (
            <p className="text-base font-semibold text-ink-faint">Create a list on the Lists screen first.</p>
          )}
          {lists.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => place('list', { listId: l.id })}
              className="pressable flex items-center gap-3 rounded-2xl bg-paper-deep/50 p-4 text-left"
            >
              <span className="h-5 w-5 rounded-full" style={{ backgroundColor: l.color }} />
              <span className="text-lg font-bold">{l.name}</span>
            </button>
          ))}
        </div>
      ) : picker === 'camera' ? (
        <CameraPicker onPick={(cameraId) => place('camera', { cameraId })} />
      ) : picker === 'birdnet' ? (
        <BirdNetPicker onPick={(birdnetUrl) => place('birdnet', { birdnetUrl })} />
      ) : picker === 'news' ? (
        <div className="flex flex-col gap-4 pb-2">
          {(['us', 'world'] as const).map((region) => (
            <div key={region}>
              <FieldLabel>{region === 'us' ? 'United States' : 'World'}</FieldLabel>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {PRESET_FEEDS.filter((f) => f.region === region).map((feed) => (
                  <button
                    key={feed.id}
                    type="button"
                    onClick={() => place('news', { feedId: feed.id })}
                    className="pressable rounded-2xl bg-paper-deep/50 p-4 text-left text-lg font-bold"
                  >
                    {feed.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 pb-2 sm:grid-cols-2">
          {TILE_TYPES.map((type) => {
            const meta = TILE_REGISTRY[type]
            const spec = TILE_SPECS[type]
            const alreadyPlaced = !spec.allowMultiple && layout.some((t) => t.type === type)
            return (
              <button
                key={type}
                type="button"
                disabled={alreadyPlaced}
                onClick={() =>
                  type === 'list' || type === 'news' || type === 'camera' || type === 'birdnet'
                    ? setPicker(type)
                    : place(type)
                }
                className="pressable rounded-2xl bg-paper-deep/50 p-4 text-left disabled:opacity-40"
              >
                <span className="block text-lg font-bold">{meta.label}</span>
                <span className="block text-sm font-semibold text-ink-faint">
                  {alreadyPlaced ? 'Already added' : meta.description}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </Sheet>
  )
}

function CameraPicker({ onPick }: { onPick: (cameraId: string) => void }) {
  const queryClient = useQueryClient()
  const pushToast = useToasts((s) => s.push)
  const { data: cameras = [] } = useQuery({ queryKey: ['cameras'], queryFn: () => ipcInvoke('camera:list', undefined) })
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')

  const addCamera = useMutation({
    mutationFn: (input: { name: string; url: string }) => ipcInvoke('camera:add', input),
    onSuccess: (camera) => {
      void queryClient.invalidateQueries({ queryKey: ['cameras'] })
      setName('')
      setUrl('')
      onPick(camera.id)
    },
    onError: (err: Error) => pushToast(err.message)
  })

  const removeCamera = useMutation({
    mutationFn: (input: { cameraId: string }) => ipcInvoke('camera:remove', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['cameras'] }),
    onError: (err: Error) => pushToast(err.message)
  })

  return (
    <div className="flex flex-col gap-3 pb-2">
      {cameras.map((camera) => (
        <div key={camera.id} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPick(camera.id)}
            className="pressable min-w-0 flex-1 rounded-2xl bg-paper-deep/50 p-4 text-left text-lg font-bold"
          >
            {camera.name}
          </button>
          <button
            type="button"
            aria-label={`Delete camera ${camera.name}`}
            onClick={() => removeCamera.mutate({ cameraId: camera.id })}
            className="pressable flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-ink-faint hover:bg-paper-deep"
          >
            <XIcon size={18} />
          </button>
        </div>
      ))}

      <UnifiPicker onImported={(cameraId) => onPick(cameraId)} />
      <div className="flex flex-col gap-2 rounded-2xl bg-paper-deep/50 p-4">
        <FieldLabel>Add a camera manually</FieldLabel>
        <OskInput value={name} onChange={setName} placeholder="Name (e.g. Front door)" />
        <OskInput value={url} onChange={setUrl} placeholder="rtsp://user:password@192.168.1.50:554/stream1" />
        <p className="text-sm font-semibold text-ink-faint">
          Use your camera's H.264 stream URL (check its app or manual). The URL is stored encrypted on this device.
        </p>
        <BigButton
          onClick={() => addCamera.mutate({ name: name.trim() || 'Camera', url: url.trim() })}
          disabled={!/^rtsps?:\/\/.+/i.test(url.trim()) || addCamera.isPending}
        >
          Add camera & place tile
        </BigButton>
      </div>
    </div>
  )
}

function BirdNetPicker({ onPick }: { onPick: (url: string) => void }) {
  const pushToast = useToasts((s) => s.push)
  const [url, setUrl] = useState('')
  const [testing, setTesting] = useState(false)

  const testAndAdd = async (): Promise<void> => {
    setTesting(true)
    try {
      // the service normalizes (e.g. strips /ui/dashboard) and returns the origin to persist
      const result = await ipcInvoke('birdnet:getDetections', { url: url.trim() })
      onPick(result.url)
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Could not reach BirdNET-Go')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-paper-deep/50 p-4">
      <FieldLabel>BirdNET-Go address</FieldLabel>
      <OskInput value={url} onChange={setUrl} placeholder="http://192.168.0.208:8080" />
      <p className="text-sm font-semibold text-ink-faint">
        Enter your BirdNET-Go web address on the LAN. The dashboard URL is fine — we'll trim it.
      </p>
      <BigButton onClick={() => void testAndAdd()} disabled={!/^https?:\/\/.+/i.test(url.trim()) || testing}>
        {testing ? 'Testing…' : 'Test & place tile'}
      </BigButton>
    </div>
  )
}


function UnifiPicker({ onImported }: { onImported: (cameraId: string) => void }) {
  const queryClient = useQueryClient()
  const pushToast = useToasts((s) => s.push)
  const [host, setHost] = useState('')
  const [apiKey, setApiKey] = useState('')
  const status = useQuery({ queryKey: ['unifiStatus'], queryFn: () => ipcInvoke('unifi:getStatus', undefined) })
  const cameras = useQuery({
    queryKey: ['unifiCameras'],
    queryFn: () => ipcInvoke('unifi:listCameras', undefined),
    enabled: status.data?.configured === true,
    staleTime: 60_000
  })
  const connect = useMutation({
    mutationFn: (input: { host: string; apiKey: string }) => ipcInvoke('unifi:connect', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['unifiStatus'] })
      void queryClient.invalidateQueries({ queryKey: ['unifiCameras'] })
      setHost('')
      setApiKey('')
    },
    onError: (err: Error) => pushToast(err.message)
  })
  const disconnect = useMutation({
    mutationFn: () => ipcInvoke('unifi:disconnect', undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['unifiStatus'] })
      void queryClient.invalidateQueries({ queryKey: ['unifiCameras'] })
    }
  })
  const importCamera = useMutation({
    mutationFn: (input: { unifiCameraId: string }) => ipcInvoke('unifi:importCamera', input),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['unifiCameras'] })
      void queryClient.invalidateQueries({ queryKey: ['cameras'] })
      onImported(res.cameraId)
    },
    onError: (err: Error) => pushToast(err.message)
  })
  if (status.data?.configured) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl bg-paper-deep/50 p-4">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-lg font-bold">UniFi Protect · {status.data.host}</span>
          <button
            type="button"
            onClick={() => disconnect.mutate(undefined)}
            className="pressable rounded-full border-2 border-ember-soft px-4 py-1.5 text-sm font-bold text-ember-deep"
          >
            Forget
          </button>
        </div>
        {cameras.isPending && <p className="text-sm font-bold text-ink-faint">Loading cameras…</p>}
        {cameras.data?.length === 0 && (
          <p className="text-sm font-semibold text-ink-faint">No cameras found on this console.</p>
        )}
        {(cameras.data ?? []).map((cam) => (
          <div key={cam.id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => importCamera.mutate({ unifiCameraId: cam.id })}
              className="pressable min-w-0 flex-1 rounded-2xl bg-card p-3 text-left"
            >
              <span className="block truncate text-base font-bold">{cam.name}</span>
              <span className="block text-sm font-bold text-ink-faint">
                {cam.model}
                {cam.imported ? ' · added' : ''}
              </span>
            </button>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-paper-deep/50 p-4">
      <FieldLabel>UniFi Protect</FieldLabel>
      <p className="text-sm font-semibold text-ink-faint">
        Connect your UniFi OS console to list its cameras automatically. Create an API key on the
        console under Settings → Control Plane → Integrations.
      </p>
      <OskInput value={host} onChange={setHost} placeholder="Console host (e.g. 192.168.1.1)" />
      <OskInput value={apiKey} onChange={setApiKey} placeholder="API key" />
      <BigButton
        onClick={() => connect.mutate({ host: host.trim(), apiKey: apiKey.trim() })}
        disabled={!host.trim() || apiKey.trim().length < 10 || connect.isPending}
      >
        {connect.isPending ? 'Connecting…' : 'Connect UniFi Protect'}
      </BigButton>
    </div>
  )
}
