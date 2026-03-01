import { randomUUID } from "node:crypto"

import * as Y from "yjs"
import * as awarenessProtocol from "y-protocols/awareness"
import type { WebSocket } from "ws"

import { config } from "./config.js"
import { forwardUpdate, forwardUpdateNow } from "./forwarding.js"
import { broadcastAwarenessUpdate, broadcastDocUpdate, isOpen } from "./yjsProtocol.js"
import { UserRole, type Conn, type Room, type RoomName } from "./types.js"
import { verifyAuthToken } from "./auth.js"
import { hydrateRoomFromBackend } from "./persistence.js"
import { fetchUserRole } from "./internalApi.js"
import EventEmitter from "node:events"
import { logger } from "./logger.js"
import { syncRedis } from "./redis.js"

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
      logger.error({ roomName: name, error: err }, "Room hydration failed")
    })

  return room
}

function setupDocListeners(room: Room) {
  room.doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "redis") {
      logger.trace({ roomName: room.name }, "Applying authorized update from Redis")
      // We only broadcast to LOCAL users connected to this server
      broadcastDocUpdate(room, update, origin)
      return // Stop here so we don't re-publish to Redis
    }

    // get origin connection
    let originConn: Conn | undefined
    if (origin && typeof origin === "object" && "send" in (origin as any)) {
      const originWs = origin as WebSocket
      originConn = Array.from(room.conns).find(c => c.ws === originWs)
    }

    // only owner and editor can edit document
    if (
      !originConn ||
      (originConn.userRole !== UserRole.Owner && originConn.userRole !== UserRole.Editor)
    ) {
      if (originConn) {
        logger.warn(
          { roomName: room.name, userId: originConn.userId, userRole: originConn.userRole },
          "Update rejected: insufficient permissions",
        )
      }
      return
    }

    logger.trace(
      { roomName: room.name, updateSize: update.length, userId: originConn.userId },
      "Broadcasting document update",
    )

    broadcastDocUpdate(room, update, origin)

    // publish update to redis
    syncRedis.publishDoc(room.name, update)

    // skip forward update if it's not from origin
    if (!originConn) return
    forwardUpdate(room, update, originConn).catch(err => {
      logger.error({ roomName: room.name, error: err }, "Document update forwarding failed")
    })
  })
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
  const authInfo = verifyAuthToken(authToken, ws)
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
            await forwardUpdateNow(room, finalUpdate, room.forwardQueue.lastUserId)
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

/**
 * Delete room and notify all clients
 */
export async function handleDocumentDeleted(roomName: string): Promise<number> {
  const room = rooms.get(roomName)
  if (!room) return 0

  const notificationPromises: Promise<void>[] = []
  room.conns.forEach(conn => {
    if (isOpen(conn.ws)) {
      // kick client from room
      const promise = new Promise<void>((resolve, reject) => {
        conn.ws.send(JSON.stringify({ type: "document-deleted" }), err => {
          if (err) return reject(err)
          conn.ws.close(1008, "document deleted")
          resolve()
        })
      })
      notificationPromises.push(promise)
    }
  })
  await Promise.all(notificationPromises)
  removeRoom(room)
  return notificationPromises.length
}

/**
 * Notify client its role changed
 */
export async function handleUserRoleChanged(
  roomName: string,
  userId: string,
  role: string,
): Promise<number> {
  const room = rooms.get(roomName)
  if (!room) return 0

  const notificationPromises: Promise<void>[] = []

  room.conns.forEach(conn => {
    if (conn.userId === String(userId)) {
      conn.userRole = role as UserRole
      if (isOpen(conn.ws)) {
        // Create a promise for each WS notification
        const promise = new Promise<void>((resolve, reject) => {
          if (role === UserRole.None) {
            // kick client from room
            conn.ws.send(JSON.stringify({ type: "kicked" }), err => {
              if (err) return reject(err)
              conn.ws.close(1008, "No access")
              resolve()
            })
          } else {
            conn.ws.send(JSON.stringify({ type: "permission-changed", role }), err => {
              if (err) return reject(err)
              resolve()
            })
          }
        })
        notificationPromises.push(promise)
      }
    }
  })
  await Promise.all(notificationPromises)
  return notificationPromises.length
}

export function getLatestDocState(room: Room): Buffer<ArrayBuffer> {
  const stateUpdate = Y.encodeStateAsUpdate(room.doc)
  return Buffer.from(stateUpdate)
}
