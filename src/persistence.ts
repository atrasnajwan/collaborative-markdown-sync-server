import * as Y from "yjs"
import type { Room } from "./types.js"
import { fetchLastDocumentState } from "./internalApi.js"

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
    Y.applyUpdate(doc, snapshotUpdate)
  }

  const sortedUpdates = [...state.updates].sort((a, b) => a.seq - b.seq)
  for (const u of sortedUpdates) {
    if (!u.binary) continue
    const update = decodeBase64ToUint8Array(u.binary)
    Y.applyUpdate(doc, update)
  }
}

/**
 * Fetch initial document state for a room from the internal documents API
 * and apply it to the room's Y.Doc.
 */
export async function hydrateRoomFromBackend(room: Room) {
  const docId = room.name.replace("doc-", "")
  const state = await fetchLastDocumentState(docId)
  if (!state) return
  applyDocumentStateToYDoc(room.doc, state)
}
