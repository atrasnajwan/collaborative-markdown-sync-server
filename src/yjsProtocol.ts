import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
import type { WebSocket } from "ws"
import type { Conn, Room } from "./types.js"

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
  if (!isOpen(ws)) return

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
  for (const c of room.conns) {
    if (c.ws === except) continue
    // if (!c.synced) {
    //   console.log(`[broadcast] conn: ${c.userId} not synced`)
    //   return
    // }
    sendMessage(c.ws, message)
  }
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
  broadcast(room, message, exceptWs)
}

/**
 * Send the initial sync step (state vector + document) to a new client.
 */
export function sendInitSyncStep(ws: WebSocket, room: Room) {
  const message = writeVarUintMessage(messageSync, enc => {
    syncProtocol.writeSyncStep1(enc, room.doc)
  })
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
  sendMessage(ws, message)
}

/**
 * Decode a raw incoming Yjs message and route it to the appropriate
 * sync / awareness handler, optionally replying back to the client.
 */
export function handleIncoming(room: Room, conn: Conn, data: Uint8Array) {
  // if (!conn.synced) {
  //   console.log(`[handleIncoming] conn: ${conn.userId} not synced`)
  //   return
  // }
  const decoder = decoding.createDecoder(data)
  const messageType = decoding.readVarUint(decoder)

  switch (messageType) {
    case messageSync: {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      const beforeLength = encoding.length(encoder)
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn.ws)
      const afterLength = encoding.length(encoder)

      // Only send if something was appended
      if (afterLength > beforeLength) {
        sendMessage(conn.ws, encoding.toUint8Array(encoder))
      }
      break
    }
    case messageAwareness: {
      const update = decoding.readVarUint8Array(decoder)
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, conn.ws)
      break
    }
    case messageAuth: {
      break
    }
    case messageQueryAwareness: {
      sendAwareness(conn.ws, room)
      break
    }
    default: {
      break
    }
  }
}
