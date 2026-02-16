import { logger } from './logger.js'
import { createServer, Server } from "node:http"
import { WebSocketServer } from "ws"
import * as Y from "yjs"

import { normalizeRoomFromUrl, config } from "./config.js"
import {
  cleanupConn,
  createConn,
  getOrCreateRoom,
  rooms,
  setupRoomDestroyer,
  touchRoom,
} from "./rooms.js"
import { handleIncoming, sendAwareness, sendInitSyncStep } from "./yjsProtocol.js"
import { postDocumentSnapshot } from "./internalApi.js"
import { handleInternalAPI } from "./apiHandlers.js"
import { UserRole } from "./types.js"

/**
 * Boot the HTTP + WebSocket server.
 *
 * - Exposes a `/healthz` HTTP endpoint.
 * - Exposes a `/internal/` endpoint
 * - Accepts WebSocket connections on `ws://HOST:PORT/<room>`.
 */
export function startServer(): Server {
  const httpServer = createServer((req, res) => {
    const { url } = req

    // Health check
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ ok: true }))
    }

    // Route Internal API Requests /internal
    if (url?.startsWith("/internal/")) {
      logger.debug({ url }, 'Processing internal API request')
      return handleInternalAPI(req, res, rooms)
    }

    logger.warn({ url }, 'HTTP request to unknown endpoint')
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ server: httpServer })

  wss.on("connection", async (ws, req) => {
    logger.info({ ip: req.socket.remoteAddress }, 'Client connected')
    const roomName = normalizeRoomFromUrl(req.url)

    if (!roomName) {
      logger.warn({ url: req.url }, 'Invalid room name')
      ws.close(1008, "Invalid room")
      return
    }
    // Extract JWT from query string: ws://host:port/room?token=JWT_HERE
    let authToken: string | undefined
    if (req.url) {
      const url = new URL(req.url, `http://${config.HOST}:${config.PORT}`)
      const token = url.searchParams.get("token")
      if (token) {
        authToken = token
      }
    }

    if (!authToken) {
      logger.warn({ roomName }, 'Connection attempt without auth token')
      ws.close(1008, "Unauthorized")
      return
    }

    const room = getOrCreateRoom(roomName)
    touchRoom(room)
    
    logger.debug({ roomName }, 'Creating connection')
    const conn = await createConn(ws, roomName, authToken)

    if (conn.userId === '') {
      logger.warn({ roomName }, 'Connection rejected: empty userId after auth')
      ws.close(1008, "Unauthorized")
      return
    }

    if (conn.userRole === UserRole.None) {
      logger.warn({ roomName, userId: conn.userId }, 'Connection rejected: user has no access')
      ws.send(JSON.stringify({type: "no-access"}))
      ws.close(1008, "Unauthorized")
      return
    }

    room.conns.add(conn)
    logger.info({ roomName, userId: conn.userId, userRole: conn.userRole, connId: conn.id }, 'Connection established')

    room.awareness.setLocalStateField("connectionId", conn.id)

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        logger.debug({ roomName, connId: conn.id }, 'Received non-binary message, ignoring')
        return
      }

      const messageData: Uint8Array =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? new Uint8Array(Buffer.concat(data))
            : new Uint8Array(data as Buffer)
      
      logger.trace({ roomName, connId: conn.id, dataSize: messageData.length }, 'Processing incoming message')
      touchRoom(room)
      handleIncoming(room, conn, messageData)
    })

    // Handle the Sync Handshake
    const startSync = () => {
      logger.info({ roomName, connId: conn.id }, 'Starting sync handshake')
      sendInitSyncStep(ws, room)
      sendAwareness(ws, room)
      conn.synced = true
      logger.debug({ roomName, connId: conn.id }, 'Sync handshake complete')
    }

    if (room.ready) {
      logger.debug({ roomName }, 'Room already ready, starting sync')
      startSync()
    } else {
      logger.debug({ roomName }, 'Room not ready, waiting for hydration')
      room.emitter.once("ready", startSync)
    }

    ws.on("close", () => {
      logger.info({ roomName, connId: conn.id, userId: conn.userId }, 'Connection closed')
      cleanupConn(room, conn)
    })

    ws.on("error", (error) => {
      logger.error({ roomName, connId: conn.id, error }, 'WebSocket error')
      cleanupConn(room, conn)
    })
  })

  setupRoomDestroyer()

  httpServer.listen(config.PORT, config.HOST, () => {
    logger.info({ port: config.PORT, host: config.HOST }, 'Server listening')
  })

  return httpServer
}

export async function persistAllRooms() {
  logger.info({ roomCount: rooms.size }, 'Starting room persistence')
  const promises = Array.from(rooms.values()).map(async room => {
    try {
      logger.debug({ roomName: room.name }, 'Saving room state')
      const docId = room.name.replace("doc-", "")
      const stateUpdate = Y.encodeStateAsUpdate(room.doc)
      const binary = Buffer.from(stateUpdate)

      await postDocumentSnapshot(docId, binary)
      logger.debug({ roomName: room.name, size: binary.length }, 'Room state saved successfully')
    } catch (e) {
      logger.error({ roomName: room.name, error: e }, 'Failed to save room state')
    }
  })
  await Promise.all(promises)
  logger.info('Room persistence complete')
}
