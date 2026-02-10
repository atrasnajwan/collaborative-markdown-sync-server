import * as Y from "yjs"
import { config } from "./config.js"
import type { Conn, Room } from "./types.js"
import { postDocumentUpdate } from "./internalApi.js"

/**
 * Forward each Yjs document update to the backend API.
 * When `FORWARD_DEBOUNCE_MS` is > 0, multiple updates are merged and sent
 * as a single batched update per room.
 */
export async function forwardUpdate(room: Room, update: Uint8Array, conn: Conn) {
  if (config.FORWARD_DEBOUNCE_MS > 0) {
    if (!room.forwardQueue) room.forwardQueue = { updates: [] }
    room.forwardQueue.updates.push(update)
    if (!room.forwardQueue.timer) {
      room.forwardQueue.timer = setTimeout(() => {
        const q = room.forwardQueue
        room.forwardQueue = undefined
        if (!q) return
        const combined = Y.mergeUpdates(q.updates)
        forwardUpdateNow(room, combined, conn)
      }, config.FORWARD_DEBOUNCE_MS)
    }
    return
  }
  await forwardUpdateNow(room, update, conn)
}

async function forwardUpdateNow(room: Room, update: Uint8Array, conn: Conn): Promise<void> {
  const docId = room.name.replace("doc-", "")
  await postDocumentUpdate(docId, update, conn.userId)
}
