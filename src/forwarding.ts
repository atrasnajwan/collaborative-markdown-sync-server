import * as Y from "yjs"
import { config } from "./config.js"
import type { Conn, Room } from "./types.js"
import { postDocumentUpdate } from "./internalApi.js"
import { logger } from "./logger.js"

/**
 * Forward each Yjs document update to the backend API.
 * When `FORWARD_DEBOUNCE_MS` is > 0, multiple updates are merged and sent
 * as a single batched update per room.
 */
export async function forwardUpdate(room: Room, update: Uint8Array, conn: Conn) {
  if (!config.BACKEND_API_URL) {
    logger.trace({ roomName: room.name }, 'Skipping forward: BACKEND_API_URL not configured')
    return
  }

  if (config.FORWARD_DEBOUNCE_MS <= 0) {
    logger.trace({ roomName: room.name, updateSize: update.length }, 'Forwarding update immediately')
    return forwardUpdateNow(room, update, conn)
  }

  if (!room.forwardQueue) {
    room.forwardQueue = { updates: [] }
  }

  room.forwardQueue.updates.push(update)
  logger.trace({ roomName: room.name, queueSize: room.forwardQueue.updates.length }, 'Queued update for debounced forwarding')

  if (room.forwardQueue.timer) {
    return
  }

  room.forwardQueue.timer = setTimeout(async () => {
    if (!room.forwardQueue || room.forwardQueue.updates.length === 0) return

    const mergedUpdate = Y.encodeStateAsUpdate(room.doc)
    logger.debug({ roomName: room.name, mergedUpdateSize: mergedUpdate.length, updateCount: room.forwardQueue.updates.length }, 'Forwarding merged updates')

    room.forwardQueue.updates = []
    room.forwardQueue.timer = undefined

    try {
      await forwardUpdateNow(room, mergedUpdate, conn)
    } catch (err) {
      logger.error({ roomName: room.name, error: err }, 'Failed to forward merged updates')
    }
  }, config.FORWARD_DEBOUNCE_MS)
}

async function forwardUpdateNow(room: Room, update: Uint8Array, conn: Conn): Promise<void> {
  const docId = room.name.replace("doc-", "")
  logger.debug({ roomName: room.name, docId, userId: conn.userId, updateSize: update.length }, 'Forwarding update to backend')

  try {
    await postDocumentUpdate(docId, update, conn.userId)
    logger.trace({ roomName: room.name, docId }, 'Update forwarded successfully')
  } catch (err) {
    logger.error({ roomName: room.name, docId, error: err }, 'Failed to forward update to backend')
    throw err
  }
}
