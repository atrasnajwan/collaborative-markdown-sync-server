import { createClient, RedisClientType } from "redis"
import { config } from "../config/config.js"
import { logger } from "./logger.js"
import * as Y from "yjs"
import { Room } from "../types/room.js"
import * as awarenessProtocol from "y-protocols/awareness"
import { getLatestDocState, handleDocumentDeleted } from "../core/documents.js"
import { handleUserRoleChanged } from "../core/users.js"

class SyncRedis {
  public pubClient: RedisClientType | null = null
  public subClient: RedisClientType | null = null
  private subscribedRooms = new Set<string>()
  public isEnabled: boolean = false

  constructor() {
    logger.debug({ addr: config.REDIS_ADDRESS }, "Init Redis")
    if (!config.REDIS_ADDRESS) {
      logger.info("Redis address not found. Running in Single-Server mode.")
      return
    }
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
    if (!this.pubClient || !this.subClient) return

    this.setHandlers()
    await Promise.all([await this.pubClient.connect(), await this.subClient.connect()])
    this.isEnabled = true
    logger.info("Redis connected")
  }

  private setHandlers() {
    if (!this.pubClient || !this.subClient) return

    this.pubClient.on("error", err => logger.error({ error: err }, "Redis pubClient Error", err))
    this.subClient.on("error", err => logger.error({ error: err }, "Redis subClient Error", err))
    this.pubClient.on("connect", () => logger.debug("Redis pubClient connecting..."))
    this.subClient.on("connect", () => logger.debug("Redis subClient connecting..."))
  }

  public async disconnect() {
    if (!this.isEnabled || !this.pubClient || !this.subClient) return

    logger.info(`Disconnecting redis...`)
    await Promise.all([this.pubClient.quit(), this.subClient.quit()])
    logger.info("Redis disconnected")
  }

  private getDocChannel(roomName: string): string {
    return `sync:doc:${roomName}`
  }

  private getDocSnapshotChannel(roomName: string): string {
    return `snapshot:doc:${roomName}`
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
      this.subscribeSnapshotRequest(room)
      this.subscribeNotification(room)
    }
  }
  public subscribeSnapshotRequest(room: Room) {
    if (!this.subClient) return

    const channel = this.getDocSnapshotChannel(room.name)
    logger.debug({ channel }, "[Snapshot] Subscribe to channel")

    this.subClient.subscribe(channel, async responseChannel => {
      try {
        logger.trace(
          { responseChannel, roomName: room.name },
          "[Snapshot] Processing published message",
        )

        const state = getLatestDocState(room)
        if (this.pubClient) {
          return await this.pubClient.publish(responseChannel, Buffer.from(state))
        }
      } catch (err) {
        logger.error({ error: err }, "[Snapshot] Failed to apply update from redis")
      }
    })
  }

  public publishSnapshotRequest(roomName: string, responseChannel: string) {
    if (!this.isEnabled || !this.pubClient) return
    logger.trace({ roomName, responseChannel }, "[Snapshot] Publish to channel")
    const channel = this.getDocSnapshotChannel(roomName)
    this.pubClient.publish(channel, responseChannel)
  }

  // temporary channel to receive snapshot response from `snapshot:doc:${roomName}` channel
  public subscribeSnapshotResponse(responseChannel: string): Promise<Buffer<ArrayBuffer>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.subClient) {
          this.subClient.unsubscribe(responseChannel)
        }
        reject(new Error("Timeout waiting for document owner"))
      }, 5000)

      if (!this.subClient) {
        reject(new Error("SubClient not initialized"))
        return
      }

      this.subClient.subscribe(
        responseChannel,
        (message: Buffer) => {
          clearTimeout(timeout)
          if (this.subClient) {
            this.subClient.unsubscribe(responseChannel)
          }
          resolve(Buffer.from(message))
        },
        true,
      ) // set return as Buffer
    })
  }

  public subscribeDoc(room: Room) {
    if (!this.subClient) return

    const channel = this.getDocChannel(room.name)
    logger.debug({ channel }, "[Document] Subscribe to channel")

    this.subClient.subscribe(
      channel,
      (message: Buffer) => {
        try {
          const update = new Uint8Array(message)
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
      },
      true,
    ) // set return as Buffer
  }

  public publishDoc(roomName: string, update: Uint8Array) {
    if (!this.isEnabled || !this.pubClient) return

    logger.trace({ roomName, messageLength: update.length }, "[Document] Publish to channel")
    const channel = this.getDocChannel(roomName)
    const message = Buffer.from(update)
    this.pubClient.publish(channel, message)
  }

  public subscribeAwareness(room: Room) {
    if (!this.subClient) return

    const channel = this.getAwarenessChannel(room.name)
    logger.debug({ channel }, "[Awareness] Subscribe to channel")

    this.subClient.subscribe(
      channel,
      (message: Buffer) => {
        try {
          const update = new Uint8Array(message)
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
      },
      true,
    ) // set return as Buffer
  }

  public publishAwareness(room: Room, changedClients: number[]) {
    if (!this.isEnabled || !this.pubClient) return

    logger.trace(
      { roomName: room.name, messageLength: changedClients.length },
      "[Awareness] Publish to channel",
    )
    const channel = this.getAwarenessChannel(room.name)
    const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, changedClients)
    const message = Buffer.from(update)
    this.pubClient.publish(channel, message)
  }

  public subscribeNotification(room: Room) {
    if (!this.subClient) return

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

  public publishRoleChanged(roomName: string, userId: number, role: string) {
    if (!this.isEnabled || !this.pubClient) return 0

    logger.trace({ roomName, userId, role }, "[User Role] Publish to channel")
    const channel = this.getNotificationChannel(roomName)
    const message = JSON.stringify({ userId, role, type: "role-changed" })
    return this.pubClient.publish(channel, message)
  }

  public publishDocumentDeleted(roomName: string) {
    if (!this.isEnabled || !this.pubClient) return 0

    logger.trace({ roomName }, "[Document Deleted] Publish to channel")
    const channel = this.getNotificationChannel(roomName)
    const message = JSON.stringify({ type: "document-deleted" })
    return this.pubClient.publish(channel, message)
  }

  /**
   * Acquire a short-lived distributed lock for the given room used during
   * destruction/flush. Returns `true` if the lock was obtained, `false`
   * otherwise. The lock expires automatically after a few seconds to avoid
   * blocking other servers indefinitely.
   */
  public async acquireForwardLock(roomName: string): Promise<boolean> {
    if (!this.isEnabled || !this.pubClient) return true
    const key = `lock:forward:${roomName}`
    try {
      const res = await this.pubClient.set(key, "1", { NX: true, PX: 5000 })
      // Redis client returns 'OK' on success, null if key already exists
      return res === "OK"
    } catch (err) {
      logger.error({ roomName, error: err }, "Failed to acquire forward lock")
      return false
    }
  }

  /**
   * Release the forward lock
   */
  public async releaseForwardLock(roomName: string): Promise<void> {
    if (!this.isEnabled || !this.pubClient) return
    const key = `lock:forward:${roomName}`
    try {
      await this.pubClient.del(key)
    } catch (err) {
      logger.error({ roomName, error: err }, "Failed to release forward lock")
    }
  }

  public unsubscribeRoom(roomName: string) {
    if (!this.isEnabled || !this.subClient) return
    const docChannel = this.getDocChannel(roomName)
    logger.debug({ channel: docChannel }, "[Document] Unsubscribe channel")
    this.subClient.unsubscribe(docChannel)

    const awarenessChannel = this.getAwarenessChannel(roomName)
    logger.debug({ channel: awarenessChannel }, "[Awareness] Unsubscribe channel")
    this.subClient.unsubscribe(awarenessChannel)

    const snapshotChannel = this.getDocSnapshotChannel(roomName)
    logger.debug({ channel: snapshotChannel }, "[Snapshot] Unsubscribe channel")
    this.subClient.unsubscribe(snapshotChannel)

    const notificationChannel = this.getNotificationChannel(roomName)
    logger.debug({ channel: notificationChannel }, "[Notification] Unsubscribe channel")
    this.subClient.unsubscribe(notificationChannel)

    this.subscribedRooms.delete(roomName)
  }
}
export const syncRedis = new SyncRedis()
