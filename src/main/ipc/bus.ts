export type BroadcastSink = (channel: string, payload: unknown) => void

const sinks = new Set<BroadcastSink>()

/**
 * Register a push sink (Electron windows in the desktop app, SSE clients in
 * server mode). Returns an unsubscribe function.
 */
export function addBroadcastSink(sink: BroadcastSink): () => void {
  sinks.add(sink)
  return () => {
    sinks.delete(sink)
  }
}

/** Fan a push message out to every registered sink; one bad sink never blocks the rest. */
export function broadcast(channel: string, payload: unknown): void {
  for (const sink of [...sinks]) {
    try {
      sink(channel, payload)
    } catch (err) {
      console.error(`[bus] sink failed for ${channel}:`, err)
    }
  }
}
