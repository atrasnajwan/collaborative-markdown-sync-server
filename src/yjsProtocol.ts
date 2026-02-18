import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
import type { WebSocket } from "ws"
import type { Conn, Room } from "./types.js"
import { logger } from "./logger.js"

// Message types used by y-websocket:
// 0 = sync, 1 = awareness, 2 = auth, 3 = query awareness
export const messageSync = 0
export const messageAwareness = 1
export const messageAuth = 2
export const messageQueryAwareness = 3

export function isOpen(ws: WebSocket): boolean {
  return ws.readyState === ws.OPEN
}

/**
 * Safely send a binary message over the WebSocket
 */
export function sendMessage(ws: WebSocket, message: Uint8Array) {
  if (!isOpen(ws)) {
    logger.trace({ messageSize: message.length }, 'WebSocket not open, message not sent')
    return
  }

  ws.send(message, { binary: true })
}

function writeVarUintMessage(type: number, write: (enc: encoding.Encoder) => void): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, type)
  write(enc)
  return encoding.toUint8Array(enc)
}

/**
 * Low‑level helper to fan out a message to all clients in a room,
 * optionally skipping a single WebSocket
 */
function broadcast(room: Room, message: Uint8Array, except?: WebSocket) {
  let sentCount = 0
  for (const c of room.conns) {
    if (c.ws === except) continue
    sendMessage(c.ws, message)
    sentCount++
  }
  logger.trace({ roomName: room.name, sentCount, totalConns: room.conns.size }, 'Message broadcast complete')
}

/**
 * Encode and broadcast a Yjs document update to everyone in the room
 * except the originating WebSocket (to avoid echoing updates).
 */
export function broadcastDocUpdate(room: Room, update: Uint8Array, origin: unknown) {
  const message = writeVarUintMessage(messageSync, enc => {
    syncProtocol.writeUpdate(enc, update)
  })

  const exceptWs =
    typeof origin === "object" && origin && "send" in (origin as any)
      ? (origin as WebSocket)
      : undefined
  
  logger.trace({ roomName: room.name, messageSize: message.length, hasOrigin: !!exceptWs }, 'Broadcasting document update')
  broadcast(room, message, exceptWs)
}

/**
 * Encode and broadcast awareness changes (cursor/selection, etc.)
 * for the specified client IDs to the rest of the room.
 */
export function broadcastAwarenessUpdate(room: Room, changedClients: number[], origin: unknown) {
  const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, changedClients)
  const message = writeVarUintMessage(messageAwareness, enc => {
    encoding.writeVarUint8Array(enc, update)
  })

  const exceptWs =
    typeof origin === "object" && origin && "send" in (origin as any)
      ? (origin as WebSocket)
      : undefined

  logger.trace({ roomName: room.name, changedClientsCount: changedClients.length, messageSize: message.length }, 'Broadcasting awareness update')
  broadcast(room, message, exceptWs)
}

/**
 * Send the sync step 2 to a new client.
 */
export function sendSyncStep2(ws: WebSocket, room: Room) {
  const message = writeVarUintMessage(messageSync, enc => {
    syncProtocol.writeSyncStep2(enc, room.doc)
  })

  logger.trace({ roomName: room.name, messageSize: message.length }, 'Sending sync step 2')
  sendMessage(ws, message)
}

/**
 * Send the full awareness state for all clients in the room to `ws`.
 */
export function sendAwareness(ws: WebSocket, room: Room) {
  const states = room.awareness.getStates()
  if (states.size === 0) return

  const clients = Array.from(states.keys())
  const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, clients)
  const message = writeVarUintMessage(messageAwareness, enc => {
    encoding.writeVarUint8Array(enc, update)
  })

  logger.trace({ roomName: room.name, messageSize: message.length }, 'Sending awareness state')
  sendMessage(ws, message)
}

/**
 * Decode a raw incoming Yjs message and route it to the appropriate
 * sync / awareness handler, optionally replying back to the client.
 */
export function handleIncoming(room: Room, conn: Conn, data: Uint8Array) {
  const decoder = decoding.createDecoder(data)
  const messageType = decoding.readVarUint(decoder)

  logger.trace({ roomName: room.name, connId: conn.id, messageType, dataSize: data.length }, 'Handling incoming message')

  switch (messageType) {
    case messageSync: {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      const beforeLength = encoding.length(encoder)
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn.ws)
      const afterLength = encoding.length(encoder)
      
      // Only send if something was appended
      if (afterLength > beforeLength) {
        logger.trace({ roomName: room.name, connId: conn.id, responseSize: afterLength - beforeLength }, 'Sending sync response')
        sendMessage(conn.ws, encoding.toUint8Array(encoder))
      }
      break
    }
    case messageAwareness: {
      const update = decoding.readVarUint8Array(decoder)
      logger.trace({ roomName: room.name, connId: conn.id, updateSize: update.length }, 'Applying awareness update')
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, conn.ws)
      break
    }
    case messageAuth: {
      logger.trace({ roomName: room.name, connId: conn.id }, 'Auth message received (no-op)')
      break
    }
    case messageQueryAwareness: {
      logger.trace({ roomName: room.name, connId: conn.id }, 'Query awareness request received')
      sendAwareness(conn.ws, room)
      break
    }
    default: {
      logger.warn({ roomName: room.name, connId: conn.id, messageType }, 'Unknown message type')
      break
    }
  }
}
