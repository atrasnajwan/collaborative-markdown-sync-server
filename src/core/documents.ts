import { logger } from "../services/logger.js"
import { Conn, Room } from "../types/room.js"
import { isWsOpen } from "../utils/utils.js"
import { removeRoom, rooms } from "./rooms.js"
import * as Y from "yjs"
import type { WebSocket } from "ws"
import { broadcastDocUpdate } from "./yjsProtocol.js"
import { syncRedis } from "../services/redis.js"
import { forwardUpdate } from "./persistence.js"
import { UserRole } from "../types/user.js"

export class DocumentNotFoundError extends Error {}

export function setupDocListeners(room: Room) {
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

/**
 * Delete document and notify all clients
 */
export async function handleDocumentDeleted(roomName: string): Promise<number> {
  const room = rooms.get(roomName)
  if (!room) return 0

  const notificationPromises: Promise<void>[] = []
  room.conns.forEach(conn => {
    if (isWsOpen(conn.ws)) {
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
 * Decide if using redis or not
 */
export async function deleteDocument(docId: string): Promise<number> {
  const roomName = `doc-${docId}`
  if (syncRedis.isEnabled) {
    return syncRedis.publishDocumentDeleted(roomName)
  } else {
    return handleDocumentDeleted(roomName)
  }
}

export function getLatestDocState(room: Room): Buffer<ArrayBuffer> {
  const stateUpdate = Y.encodeStateAsUpdate(room.doc)
  return Buffer.from(stateUpdate)
}
