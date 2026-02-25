import { createClient, RedisClientType } from "redis"
import { config } from "./config.js"
import { logger } from "./logger.js"
import * as Y from "yjs"
import { Room } from "./types.js"
import { decodeBase64ToUint8Array } from "./persistence.js"

class SyncRedis {
  public pubClient: RedisClientType
  public subClient: RedisClientType
  private subscribedDocs = new Set<string>()

  constructor() {
    logger.debug({ addr: config.REDIS_ADDRESS }, "Init Redis")
    this.pubClient = createClient({
      url: config.REDIS_ADDRESS,
      socket: {
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

  public subscribeDoc(room: Room) {
    if (!this.subscribedDocs.has(room.name)) {
      this.subscribedDocs.add(room.name)
      const channel = `sync:doc:${room.name}`
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

  public unsubscribeDoc(roomName: string) {
    const channel = `sync:doc:${roomName}`
    logger.debug({ channel }, "Unsubscribe channel")
    syncRedis.subClient.unsubscribe(channel)
    this.subscribedDocs.delete(roomName)
  }

  public publishDoc(roomName: string, update: Uint8Array) {
    logger.trace({ roomName, messageLength: update.length }, "Publish to channel")
    const channel = `sync:doc:${roomName}`
    const message = Buffer.from(update).toString("base64")
    this.pubClient.publish(channel, message)
  }
}
export const syncRedis = new SyncRedis()
