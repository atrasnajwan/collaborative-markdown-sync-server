import * as Y from "yjs"
import type { Conn, Room, RoomName } from "../types/room.js"
import { fetchLastDocumentState } from "../services/internal.js"
import { logger } from "../services/logger.js"
import { randomUUID } from "crypto"
import { kafkaService } from "../services/kafka.js"
import { KafkaDocMessage } from "../types/kafka.js"
import { decodeBase64ToUint8Array, toBase64 } from "../utils/utils.js"
import { config } from "../config/config.js"
import { getLatestDocState } from "./documents.js"
import { DocumentState } from "../types/document.js"

/**
 * Forward each Yjs document update to the message queue.
 * When `FORWARD_DEBOUNCE_MS` is > 0, multiple updates are merged and sent
 * as a single batched update per room.
 */
export async function forwardUpdate(room: Room, update: Uint8Array, conn: Conn) {
  if (config.FORWARD_DEBOUNCE_MS <= 0) {
    logger.trace(
      { roomName: room.name, updateSize: update.length },
      "Forwarding update immediately",
    )
    return forwardUpdateNow(room, update, conn.userId)
  }

  if (!room.forwardQueue) {
    room.forwardQueue = { updates: [], lastUserId: conn.userId }
  }

  room.forwardQueue.updates.push(update)
  room.forwardQueue.lastUserId = conn.userId // Track the most recent editor

  logger.trace(
    { roomName: room.name, queueSize: room.forwardQueue.updates.length },
    "Queued update for debounced forwarding",
  )

  if (room.forwardQueue.timer) {
    return
  }

  room.forwardQueue.timer = setTimeout(async () => {
    if (!room.forwardQueue || room.forwardQueue.updates.length === 0) return

    const mergedUpdate = Y.mergeUpdates(room.forwardQueue.updates)
    const lastUserId = room.forwardQueue.lastUserId
    logger.debug(
      {
        roomName: room.name,
        mergedUpdateSize: mergedUpdate.length,
        updateCount: room.forwardQueue.updates.length,
      },
      "Forwarding merged updates",
    )

    room.forwardQueue.updates = []
    room.forwardQueue.timer = undefined

    try {
      await forwardUpdateNow(room, mergedUpdate, lastUserId)
    } catch (err) {
      logger.error({ roomName: room.name, error: err }, "Failed to forward merged updates")
      // put updates back in front of queue
      room.forwardQueue.updates.unshift(mergedUpdate)
    }
  }, config.FORWARD_DEBOUNCE_MS)
}

export async function forwardUpdateNow(
  room: Room,
  update: Uint8Array,
  userId: number,
): Promise<void> {
  const docId = room.name.replace("doc-", "")
  logger.debug(
    { roomName: room.name, docId, userId: userId, updateSize: update.length },
    "Forwarding update to backend",
  )

  try {
    const event: KafkaDocMessage = {
      event_id: randomUUID(),
      type: "document.updated",
      document_id: Number(docId),
      user_id: userId,
      timestamp: Date.now(),
      data: toBase64(update),
    }

    await kafkaService.sendMessage("document.events", [
      {
        key: docId,
        value: JSON.stringify(event),
      },
    ])
    logger.trace({ roomName: room.name, docId }, "Update forwarded successfully")
  } catch (err) {
    logger.error({ roomName: room.name, docId, error: err }, "Failed to forward update to backend")
    throw err
  }
}

// apply document state (snapshot + updates)
function applyDocumentStateToYDoc(doc: Y.Doc, state: DocumentState): void {
  if (state.snapshot && state.snapshot.length > 0) {
    const snapshotUpdate = decodeBase64ToUint8Array(state.snapshot)
    logger.trace({ snapshotSize: snapshotUpdate.length }, "Applying snapshot to Y.Doc")
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
    logger.trace({ appliedUpdateCount: appliedCount }, "Applied updates to Y.Doc")
  }
}

/**
 * Fetch initial document state for a room from the internal documents API
 * and apply it to the room's Y.Doc.
 */
export async function hydrateRoomFromBackend(room: Room) {
  const docId = room.name.replace("doc-", "")
  logger.info({ roomName: room.name, docId }, "Starting room hydration from backend")

  try {
    const state = await fetchLastDocumentState(Number(docId))
    if (!state) {
      logger.warn({ roomName: room.name, docId }, "No document state returned from backend")
      return
    }

    logger.debug(
      { roomName: room.name, docId, updateCount: state.updates.length },
      "Received document state, applying to Y.Doc",
    )
    applyDocumentStateToYDoc(room.doc, state)
    logger.info({ roomName: room.name, docId }, "Hydrate from backend complete")
  } catch (err) {
    logger.error({ roomName: room.name, docId, error: err }, "Hydrate from backend failed")
    throw err
  }
}

export async function persistAllRooms(rooms: Map<RoomName, Room>) {
  logger.info({ roomCount: rooms.size }, "Starting room persistence")
  const promises = Array.from(rooms.values()).map(async room => {
    try {
      logger.debug({ roomName: room.name }, "Saving room state")
      const docId = room.name.replace("doc-", "")
      const binary = getLatestDocState(room)

      const event: KafkaDocMessage = {
        event_id: randomUUID(),
        type: "document.snapshot",
        document_id: Number(docId),
        timestamp: Date.now(),
        data: toBase64(binary),
      }

      await kafkaService.sendMessage("document.events", [
        {
          key: docId,
          value: JSON.stringify(event),
        },
      ])

      logger.debug({ roomName: room.name, size: binary.length }, "Room state saved successfully")
    } catch (e) {
      logger.error({ roomName: room.name, error: e }, "Failed to save room state")
    }
  })
  await Promise.all(promises)
  logger.info("Room persistence complete")
}
