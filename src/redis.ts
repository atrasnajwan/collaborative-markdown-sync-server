import { createClient, RedisClientType } from "redis"
import { config } from "./config.js"
import { logger } from "./logger.js"
import * as Y from "yjs"
import { Room } from "./types.js"
import { decodeBase64ToUint8Array } from "./persistence.js"
import * as awarenessProtocol from "y-protocols/awareness"
import { handleDocumentDeleted, handleUserRoleChanged } from "./rooms.js"

class SyncRedis {
  public pubClient: RedisClientType
  public subClient: RedisClientType
  private subscribedRooms = new Set<string>()
  public isEnabled: boolean = false

  constructor() {
    logger.debug({ addr: config.REDIS_ADDRESS }, "Init Redis")
    this.pubClient = createClient({
      url: config.REDIS_ADDRESS,
      socket: {
        connectTimeout: 10000, //10s
        reconnectStrategy: retries => {
          if (retries > 20) {
            logger.error("Redis reconnection failed after 20 attempts. Giving up.")
            return new Error("Redis reconnection failed")
          }
          return Math.min(retries * 50, 2000)
        },
      },
    })
    this.subClient = this.pubClient.duplicate()
  }

  public async connect() {
    this.setHandlers()
    await Promise.all([await this.pubClient.connect(), await this.subClient.connect()])
    this.isEnabled = true
    logger.info("Redis connected")
  }

  private setHandlers() {
    this.pubClient.on("error", err => logger.error({ error: err }, "Redis pubClient Error", err))
    this.subClient.on("error", err => logger.error({ error: err }, "Redis subClient Error", err))
    this.pubClient.on("connect", () => logger.debug("Redis pubClient connecting..."))
    this.subClient.on("connect", () => logger.debug("Redis subClient connecting..."))
  }

  public async disconnect() {
    if (!this.isEnabled) return
    logger.info(`Disconnecting redis...`)
    await Promise.all([this.pubClient.quit(), this.subClient.quit()])
    logger.info("Redis disconnected")
  }

  private getDocChannel(roomName: string): string {
    return `sync:doc:${roomName}`
  }

  private getAwarenessChannel(roomName: string): string {
    return `sync:awareness:${roomName}`
  }

  private getNotificationChannel(roomName: string): string {
    return `notification:room:${roomName}`
  }

  public subscribeRoom(room: Room) {
    if (!this.isEnabled) return
    if (!this.subscribedRooms.has(room.name)) {
      this.subscribedRooms.add(room.name)
      this.subscribeDoc(room)
      this.subscribeAwareness(room)
      this.subscribeNotification(room)
    }
  }
  public subscribeDoc(room: Room) {
    const channel = this.getDocChannel(room.name)
    logger.debug({ channel }, "[Document] Subscribe to channel")

    this.subClient.subscribe(channel, message => {
      try {
        const update = decodeBase64ToUint8Array(message)
        logger.trace(
          { channel, messageLength: update.length },
          "[Document] Processing published message",
        )
        // Apply the update to the local Yjs document
        // We pass 'redis' as the origin to prevent the observer from re-publishing
        Y.applyUpdate(room.doc, update, "redis")
      } catch (err) {
        logger.error({ error: err }, "[Document] Failed to apply update from redis")
      }
    })
  }

  public publishDoc(roomName: string, update: Uint8Array) {
    if (!this.isEnabled) return
    logger.trace({ roomName, messageLength: update.length }, "[Document] Publish to channel")
    const channel = this.getDocChannel(roomName)
    const message = Buffer.from(update).toString("base64")
    this.pubClient.publish(channel, message)
  }

  public subscribeAwareness(room: Room) {
    const channel = this.getAwarenessChannel(room.name)
    logger.debug({ channel }, "[Awareness] Subscribe to channel")

    this.subClient.subscribe(channel, message => {
      try {
        const update = decodeBase64ToUint8Array(message)
        logger.trace(
          { channel, messageLength: update.length },
          "[Awareness] Processing published message",
        )
        // Apply the update to the local Yjs awareness
        // We pass 'redis' as the origin to prevent the observer from re-publishing
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, "redis")
      } catch (err) {
        logger.error({ error: err }, "[Awareness] Failed to apply update from redis")
      }
    })
  }

  public publishAwareness(room: Room, changedClients: number[]) {
    if (!this.isEnabled) return
    logger.trace(
      { roomName: room.name, messageLength: changedClients.length },
      "[Awareness] Publish to channel",
    )
    const channel = this.getAwarenessChannel(room.name)
    const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, changedClients)
    const message = Buffer.from(update).toString("base64")
    this.pubClient.publish(channel, message)
  }

  public subscribeNotification(room: Room) {
    const channel = this.getNotificationChannel(room.name)
    logger.debug({ channel }, "[Notification] Subscribe to channel")

    this.subClient.subscribe(channel, async message => {
      try {
        logger.trace({ channel, message }, "[Notification] Processing published message")
        const data = JSON.parse(message)
        if (data.type === "role-changed") {
          handleUserRoleChanged(room.name, data.userId, data.role)
        } else if (data.type === "document-deleted") {
          handleDocumentDeleted(room.name)
        }
      } catch (err) {
        logger.error({ error: err }, "[Notification] Failed to apply update from redis")
      }
    })
  }

  public publishRoleChanged(roomName: string, userId: string, role: string) {
    if (!this.isEnabled) return 0

    logger.trace({ roomName, userId, role }, "[User Role] Publish to channel")
    const channel = this.getNotificationChannel(roomName)
    const message = JSON.stringify({ userId, role, type: "role-changed" })
    return this.pubClient.publish(channel, message)
  }

  public publishDocumentDeleted(roomName: string) {
    if (!this.isEnabled) return 0

    logger.trace({ roomName }, "[Document Deleted] Publish to channel")
    const channel = this.getNotificationChannel(roomName)
    const message = JSON.stringify({ type: "document-deleted" })
    return this.pubClient.publish(channel, message)
  }

  public unsubscribeRoom(roomName: string) {
    if (!this.isEnabled) return
    const docChannel = this.getDocChannel(roomName)
    logger.debug({ channel: docChannel }, "[Document] Unsubscribe channel")
    syncRedis.subClient.unsubscribe(docChannel)

    const awarenessChannel = this.getAwarenessChannel(roomName)
    logger.debug({ channel: awarenessChannel }, "[Awareness] Unsubscribe channel")
    syncRedis.subClient.unsubscribe(awarenessChannel)

    const notificationChannel = this.getNotificationChannel(roomName)
    logger.debug({ channel: notificationChannel }, "[Notification] Unsubscribe channel")
    syncRedis.subClient.unsubscribe(notificationChannel)

    this.subscribedRooms.delete(roomName)
  }
}
export const syncRedis = new SyncRedis()
