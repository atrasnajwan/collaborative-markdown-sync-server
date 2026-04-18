import { randomUUID } from "node:crypto"

import * as Y from "yjs"
import * as awarenessProtocol from "y-protocols/awareness"
import type { WebSocket } from "ws"

import { config } from "../config/config.js"
import { broadcastAwarenessUpdate } from "./yjsProtocol.js"
import { type Conn, type Room, type RoomName } from "../types/room.js"
import { verifyClientAuthToken } from "./auth.js"
import { forwardUpdateNow, hydrateRoomFromBackend } from "./persistence.js"
import { fetchUserRole } from "../services/internal.js"
import EventEmitter from "node:events"
import { logger } from "../services/logger.js"
import { syncRedis } from "../services/redis.js"
import { DocumentNotFoundError, getLatestDocState, setupDocListeners } from "./documents.js"
import { UserRole } from "../types/user.js"
import { KafkaDocMessage } from "../types/kafka.js"
import { kafkaService } from "../services/kafka.js"
import { toBase64 } from "../utils/utils.js"

/**
 * In‑memory registry of all active rooms
 */
export const rooms = new Map<RoomName, Room>()

/**
 * Get an existing room or create a new Y.Doc + Awareness instance for `name`.
 * Also wires up listeners to broadcast and forward document updates.
 *
 */
export function getOrCreateRoom(name: RoomName): Room {
  const existing = rooms.get(name)
  if (existing) {
    logger.trace({ roomName: name }, "Retrieved existing room")
    return existing
  }

  logger.info({ roomName: name }, "Creating new room")
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)

  const room: Room = {
    name,
    doc,
    awareness,
    conns: new Set(),
    lastActiveAt: Date.now(),
    ready: false,
    emitter: new EventEmitter(),
  }

  rooms.set(name, room)

  // set initial content
  hydrateRoomFromBackend(room)
    .then(() => {
      logger.info({ roomName: name }, "Room hydration complete")
      room.ready = true

      setupDocListeners(room)
      setupAwarenessListeners(room)
      // Tell everyone waiting: "The data is ready!"
      room.emitter.emit("ready")
    })
    .catch(err => {
      // TODO: send message to client if failed
      logger.error({ roomName: name, error: err }, "Room hydration failed")
    })

  return room
}

function setupAwarenessListeners(room: Room) {
  room.awareness.on(
    "update",
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const changedClients = added.concat(updated, removed)
      if (changedClients.length === 0) return

      if (origin === "redis") {
        logger.trace({ roomName: room.name }, "[Awareness] Applying authorized update from Redis")
        // We only broadcast to LOCAL users connected to this server
        broadcastAwarenessUpdate(room, changedClients, origin)
        return // Stop here so we don't re-publish to Redis
      }

      logger.trace(
        {
          roomName: room.name,
          added: added.length,
          updated: updated.length,
          removed: removed.length,
        },
        "Broadcasting awareness update",
      )
      broadcastAwarenessUpdate(room, changedClients, origin)
      // publish update to redis
      syncRedis.publishAwareness(room, changedClients)
    },
  )
}

/**
 * Mark a room as recently used, so GC does not collect it too early.
 */
export function touchRoom(room: Room) {
  room.lastActiveAt = Date.now()
}

export async function createConn(
  ws: WebSocket,
  roomName: RoomName,
  authToken: string,
): Promise<Conn> {
  // Yjs awareness identifies each client by a numeric ID, so we generate
  // a random 31‑bit integer for this WebSocket connection and reuse it
  // for the life of the connection.
  const awarenessClientId = (Math.random() * 0x7fffffff) | 0
  const docId = roomName.replace("doc-", "")
  const authInfo = verifyClientAuthToken(authToken, ws)
  const userId = authInfo.userId
  logger.debug({ roomName, userId }, "Token verified")

  let userRole: UserRole = UserRole.None
  try {
    const roleInfo = await fetchUserRole(docId, userId)
    userRole = roleInfo.role
    logger.debug({ roomName, userId, userRole }, "User role fetched")
  } catch (err) {
    logger.warn({ roomName, error: err }, "Role fetch failed")
    ws.close(4001, "Unauthorized")
  }

  const conn = {
    id: randomUUID(),
    ws,
    room: roomName,
    awarenessClientId,
    closed: false,
    userId,
    userRole,
  }
  return conn
}

/**
 * Remove a connection from the room and clear its awareness state.
 */
export function cleanupConn(room: Room, conn: Conn) {
  if (conn.closed) return
  conn.closed = true
  room.conns.delete(conn)

  logger.debug(
    { roomName: room.name, connId: conn.id, userId: conn.userId, totalConns: room.conns.size },
    "Connection cleaned up",
  )
  awarenessProtocol.removeAwarenessStates(room.awareness, [conn.awarenessClientId], conn.ws)
  touchRoom(room)
}

/**
 * Periodically scan for idle rooms(unused for certain time) and destroy their Y.Doc instances.
 */
export function setupRoomDestroyer() {
  setInterval(async () => {
    const now = Date.now()
    let destroyedCount = 0

    for (const [name, room] of rooms.entries()) {
      if (room.conns.size > 0) continue
      if (now - room.lastActiveAt < config.ROOM_TTL_MS) continue

      // If there's a pending debounce timer, clear it and save
      if (room.forwardQueue?.timer) {
        logger.info({ roomName: name }, "Flushing pending updates before destruction")
        clearTimeout(room.forwardQueue.timer)

        // Merge whatever is left in the queue and send to API
        if (room.forwardQueue.updates.length > 0) {
          const finalUpdate = Y.mergeUpdates(room.forwardQueue.updates)
          try {
            // only one server should forward when multiple instances host the same
            // document. use a redis-backed lock to ensure the request is sent once.
            const locked = await syncRedis.acquireForwardLock(room.name)
            if (locked) {
              await forwardUpdateNow(room, finalUpdate, room.forwardQueue.lastUserId)
              // release lock
              await syncRedis.releaseForwardLock(room.name)
            } else {
              logger.trace(
                { roomName: name },
                "Skipping flush: another instance already forwarded update",
              )
            }
          } catch (err) {
            logger.error({ roomName: name, err }, "Final flush failed during destruction")
          }
        }
      }

      logger.info({ roomName: name, idleTime: now - room.lastActiveAt }, "Destroying idle room")
      // unsubscribe channel
      syncRedis.unsubscribeRoom(room.name)
      removeRoom(room)
      destroyedCount++
    }

    if (destroyedCount > 0) {
      logger.debug({ destroyedCount, remainingRooms: rooms.size }, "Room cleanup cycle complete")
    }
  }, config.ROOM_TTL_MS)
}

export function removeRoom(room: Room) {
  logger.debug({ roomName: room.name }, "Removing room from memory")
  room.doc.destroy()
  rooms.delete(room.name)
}

export async function fetchRoomState(docId: string, rooms: Map<string, Room>): Promise<void> {
  const roomName = `doc-${docId}`
  try {
    let binary = null
    if (syncRedis.isEnabled) {
      const responseChannel = `snapshot:response:${randomUUID()}`
      syncRedis.publishSnapshotRequest(roomName, responseChannel)
      binary = await syncRedis.subscribeSnapshotResponse(responseChannel)
    } else {
      const room = rooms.get(roomName)
      if (!room) throw new DocumentNotFoundError("Document not found")
      binary = getLatestDocState(room)
    }

    if (binary) {
      // push message to kafka
      const event: KafkaDocMessage = {
        event_id: randomUUID(),
        type: "document.snapshot",
        document_id: Number(docId),
        timestamp: Date.now(),
        data: toBase64(binary),
      }

      logger.debug({ docId, binary: binary.length }, "Snapshot response")
      return kafkaService.sendMessage("document.events", [
        {
          key: docId,
          value: JSON.stringify(event),
        },
      ])
    }
  } catch (err) {
    logger.error({ error: err, docId }, "Failed to fetch last document state")
    throw err
  }
}
