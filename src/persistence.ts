import * as Y from "yjs"
import type { Room } from "./types.js"
import { fetchLastDocumentState } from "./internalApi.js"
import { logger } from "./logger.js"

export type DocumentUpdateDTO = {
  seq: number
  binary: string // JSON []byte becomes base64 string
}

export type DocumentState = {
  title: string
  snapshot: string // base64
  snapshot_seq: number
  updates: DocumentUpdateDTO[]
}

function decodeBase64ToUint8Array(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"))
}

// apply document state (snapshot + updates)
function applyDocumentStateToYDoc(doc: Y.Doc, state: DocumentState): void {
  if (state.snapshot && state.snapshot.length > 0) {
    const snapshotUpdate = decodeBase64ToUint8Array(state.snapshot)
    logger.trace({ snapshotSize: snapshotUpdate.length }, 'Applying snapshot to Y.Doc')
    Y.applyUpdate(doc, snapshotUpdate)
  }

  const sortedUpdates = [...state.updates].sort((a, b) => a.seq - b.seq)
  let appliedCount = 0
  
  for (const u of sortedUpdates) {
    if (!u.binary) continue
    const update = decodeBase64ToUint8Array(u.binary)
    Y.applyUpdate(doc, update)
    appliedCount++
  }
  
  if (appliedCount > 0) {
    logger.trace({ appliedUpdateCount: appliedCount }, 'Applied updates to Y.Doc')
  }
}

/**
 * Fetch initial document state for a room from the internal documents API
 * and apply it to the room's Y.Doc.
 */
export async function hydrateRoomFromBackend(room: Room) {
  const docId = room.name.replace("doc-", "")
  logger.info({ roomName: room.name, docId }, 'Starting room hydration from backend')
  
  try {
    const state = await fetchLastDocumentState(docId)
    if (!state) {
      logger.warn({ roomName: room.name, docId }, 'No document state returned from backend')
      return
    }
    
    logger.debug({ roomName: room.name, docId, updateCount: state.updates.length }, 'Received document state, applying to Y.Doc')
    applyDocumentStateToYDoc(room.doc, state)
    logger.info({ roomName: room.name, docId }, 'Room hydration complete')
  } catch (err) {
    logger.error({ roomName: room.name, docId, error: err }, 'Room hydration failed')
    throw err
  }
}
