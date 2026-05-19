import type { WebSocket } from "ws"
import type * as Y from "yjs"
import type * as awarenessProtocol from "y-protocols/awareness"
import EventEmitter from "node:events"
import { UserRole } from "./user.js"

export type RoomName = string

export type ForwardQueue = {
  timer?: NodeJS.Timeout
  updates: Uint8Array[]
  lastUserId: number
}

export type Conn = {
  id: string
  ws: WebSocket
  room: RoomName
  awarenessClientId: number
  closed: boolean
  userId: number
  userRole: UserRole
}

export type Room = {
  name: RoomName
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  conns: Set<Conn>
  lastActiveAt: number
  forwardQueue?: ForwardQueue
  ready: boolean
  emitter: EventEmitter
}
