import { createClient, RedisClientType } from "redis"
import { config } from "./config.js"
import { logger } from "./logger.js"
import * as Y from "yjs"
import { Room } from "./types.js"
import { decodeBase64ToUint8Array } from "./persistence.js"
import * as awarenessProtocol from "y-protocols/awareness"

class SyncRedis {
  public pubClient: RedisClientType
  public subClient: RedisClientType
  private subscribedDocs = new Set<string>()
  private subscribedAwareness = new Set<string>()

  constructor() {
    logger.debug({ addr: config.REDIS_ADDRESS }, "Init Redis")
    this.pubClient = createClient({
      url: config.REDIS_ADDRESS,
      socket: {
        connectTimeout: 10000, //10s
        // Prevents app crash if Redis restarts
        reconnectStrategy: retries => Math.min(retries * 50, 2000),
      },
    })
    this.subClient = this.pubClient.duplicate()
  }

  public async connect() {
    this.setHandlers()
    await Promise.all([await this.pubClient.connect(), await this.subClient.connect()])
    logger.info("Redis connected")
  }

  private setHandlers() {
    this.pubClient.on("error", err => logger.error({ error: err }, "Redis pubClient Error", err))
    this.subClient.on("error", err => logger.error({ error: err }, "Redis subClient Error", err))
    this.pubClient.on("connect", () => logger.debug("Redis pubClient connecting..."))
    this.subClient.on("connect", () => logger.debug("Redis subClient connecting..."))
  }

  public async disconnect() {
    await Promise.all([this.pubClient.quit(), this.subClient.quit()])
    logger.info("Redis disconnected")
  }

  private getDocChannel(roomName: string): string {
    return `sync:doc:${roomName}`
  }

  private getAwarenessChannel(roomName: string): string {
    return `sync:awareness:${roomName}`
  }

  public subscribeDoc(room: Room) {
    if (!this.subscribedDocs.has(room.name)) {
      this.subscribedDocs.add(room.name)
      const channel = this.getDocChannel(room.name)
      logger.debug({ channel }, "Subscribe to channel")

      this.subClient.subscribe(channel, message => {
        try {
          const update = decodeBase64ToUint8Array(message)
          logger.trace({ channel, messageLength: update.length }, "Processing published message")
          // Apply the update to the local Yjs document
          // We pass 'redis' as the origin to prevent the observer from re-publishing
          Y.applyUpdate(room.doc, update, "redis")
        } catch (err) {
          logger.error({ error: err }, "Failed to apply update from redis")
        }
      })
    }
  }

  public publishDoc(roomName: string, update: Uint8Array) {
    logger.trace({ roomName, messageLength: update.length }, "Publish to channel")
    const channel = this.getDocChannel(roomName)
    const message = Buffer.from(update).toString("base64")
    this.pubClient.publish(channel, message)
  }

  public unsubscribeDoc(roomName: string) {
    const channel = this.getDocChannel(roomName)
    logger.debug({ channel }, "Unsubscribe channel")
    syncRedis.subClient.unsubscribe(channel)
    this.subscribedDocs.delete(roomName)
  }

  public subscribeAwareness(room: Room) {
    if (!this.subscribedAwareness.has(room.name)) {
      this.subscribedAwareness.add(room.name)
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
  }

  public publishAwareness(room: Room, changedClients: number[]) {
    logger.trace(
      { roomName: room.name, messageLength: changedClients.length },
      "[Awareness] Publish to channel",
    )
    const channel = this.getAwarenessChannel(room.name)
    const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, changedClients)
    const message = Buffer.from(update).toString("base64")
    this.pubClient.publish(channel, message)
  }

  public unsubscribeAwareness(roomName: string) {
    const channel = this.getAwarenessChannel(roomName)
    logger.debug({ channel }, "[Awareness] Unsubscribe channel")
    syncRedis.subClient.unsubscribe(channel)
    this.subscribedAwareness.delete(roomName)
  }
}
export const syncRedis = new SyncRedis()
