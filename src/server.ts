import { logger } from "./logger.js"
import { createServer, Server } from "node:http"
import { WebSocketServer } from "ws"

import { normalizeRoomFromUrl, config } from "./config.js"
import {
  cleanupConn,
  createConn,
  getLatestDocState,
  getOrCreateRoom,
  rooms,
  setupRoomDestroyer,
  touchRoom,
} from "./rooms.js"
import { handleIncoming, sendAwareness, sendSyncStep1 } from "./yjsProtocol.js"
import { handleInternalAPI } from "./apiHandlers.js"
import { Conn, Room } from "./types.js"
import { syncRedis } from "./redis.js"
import { KafkaDocMessage } from "./services/types.js"
import { randomUUID } from "node:crypto"
import { kafkaService } from "./services/kafka.js"

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
      logger.debug({ url }, "Processing internal API request")
      return handleInternalAPI(req, res, rooms)
    }

    logger.warn({ url }, "HTTP request to unknown endpoint")
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ server: httpServer })

  wss.on("connection", async (ws, req) => {
    logger.info({ ip: req.socket.remoteAddress }, "Client connected")

    const messageQueue: any = []
    const handleMessage = (data: any, isBinary: boolean) => {
      messageQueue.push({ data, isBinary })
    }
    // temporary listener
    ws.on("message", handleMessage)

    const roomName = normalizeRoomFromUrl(req.url)

    if (!roomName) {
      logger.warn({ url: req.url }, "Invalid room name")
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
      logger.warn({ roomName }, "Connection attempt without auth token")
      ws.close(4001, "Unauthorized")
      return
    }

    const handleConnection = async () => {
      try {
        const room = getOrCreateRoom(roomName)
        touchRoom(room)

        logger.debug({ roomName }, "Creating connection")
        const conn = await createConn(ws, roomName, authToken)

        room.conns.add(conn)
        logger.info(
          { roomName, userId: conn.userId, userRole: conn.userRole, connId: conn.id },
          "Connection established",
        )

        room.awareness.setLocalStateField("connectionId", conn.id)

        // subscribe to room channel
        syncRedis.subscribeRoom(room)

        // Handle the Sync Handshake
        const startSync = () => {
          logger.info({ roomName, connId: conn.id }, "Starting sync handshake")

          // re-attach listener
          ws.on("message", (data, isBinary) =>
            handleOnMessage(data, isBinary, room, roomName, conn),
          )

          ws.off("message", handleMessage) // Remove the temporary listener

          // Drain the queue (Process messages sent during room preparation)
          logger.debug({ messageQueue: messageQueue.length }, "Message queue before init")
          for (const msg of messageQueue) {
            logger.trace(
              { roomName, connId: conn.id, data: msg.data.length },
              "Processing queue message",
            )
            handleOnMessage(msg.data, msg.isBinary, room, roomName, conn)
          }

          /*
           * The server should reply with SyncStep2 followed by SyncStep1.
           * SyncStep2 is already handled by handleIncoming
           * but we send SyncStep1 here to be absolutely sure
           * the client can finish its side.
           */
          sendSyncStep1(ws, room)
          sendAwareness(ws, room)
          logger.debug({ roomName, connId: conn.id }, "Sync handshake complete")
        }

        if (room.ready) {
          logger.debug({ roomName }, "Room already ready, starting sync")
          startSync()
        } else {
          logger.debug({ roomName }, "Room not ready, waiting for hydration")
          room.emitter.once("ready", startSync)
        }

        ws.on("close", () => {
          logger.info({ roomName, connId: conn.id, userId: conn.userId }, "Connection closed")
          cleanupConn(room, conn)
        })

        ws.on("error", error => {
          logger.error({ roomName, connId: conn.id, error }, "WebSocket error")
          cleanupConn(room, conn)
        })
      } catch (err) {
        ws.close(1011, "Internal Server Error")
        logger.error({ roomName, error: err }, "Failed to set handler")
      }
    }

    handleConnection()
  })

  setupRoomDestroyer()

  httpServer.listen(config.PORT, config.HOST, () => {
    logger.info({ port: config.PORT, host: config.HOST }, "Server listening")
  })

  return httpServer
}

function handleOnMessage(data: any, isBinary: boolean, room: Room, roomName: string, conn: Conn) {
  if (!isBinary) {
    logger.debug({ roomName, connId: conn.id }, "Received non-binary message, ignoring")
    return
  }

  const messageData: Uint8Array =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : Array.isArray(data)
        ? new Uint8Array(Buffer.concat(data))
        : new Uint8Array(data as Buffer)

  logger.trace(
    { roomName, connId: conn.id, dataSize: messageData.length },
    "Processing incoming message",
  )
  touchRoom(room)
  handleIncoming(room, conn, messageData)
}

export async function persistAllRooms() {
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
        data: Buffer.from(binary).toString("base64"),
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

