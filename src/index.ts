/**
 * Yjs WS bridge server
 *
 * - Rooms are identified by URL path: ws://host:PORT/<room>
 * - Keeps Y.Doc and awareness in-memory per room
 * - Speaks Yjs sync + awareness protocols
 * - Broadcasts updates to peers in the room
 * - Forwards doc updates to backend via gRPC/API (see proto/internal.proto)
 */

import { kafkaService } from "./services/kafka.js"
import { logger } from "./services/logger.js"
import { syncRedis } from "./services/redis.js"
import { rooms } from "./core/rooms.js"
import { startServer } from "./server.js"
import grpc from "@grpc/grpc-js"
import { persistAllRooms } from "./core/persistence.js"
import { startGrpcServer } from "./grpc/server.js"

try {
  logger.info("Connecting redis...")
  await syncRedis.connect()
} catch (err) {
  logger.error({ error: err }, "Error during starting redis")
  logger.info("Running in Single-Server mode.")
}

try {
  logger.info("Starting Kafka...")
  await kafkaService.start()
} catch (err) {
  logger.error({ error: err }, "Error during starting kafka")
  process.exit(0)
}
const server = startServer()

// spin up gRPC server for internal API
let grpcServer: grpc.Server | null = null
try {
  grpcServer = startGrpcServer()
} catch (err) {
  logger.error({ error: err }, "failed to start internal gRPC server")
}

let isShuttingDown = false

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true

  logger.info(`\n[${signal}] Received. Starting graceful shutdown...`)

  // Set a "Force Kill" timeout
  // If the API is down, we don't want the process to hang forever.
  const forceExit = setTimeout(() => {
    logger.error("[Shutdown] Timed out! Forcefully exiting.")
    if (grpcServer) grpcServer.forceShutdown()
    process.exit(1)
  }, 10000) // 10 seconds

  // Stop accepting new connections
  server.close(() => {
    logger.debug("[Shutdown] HTTP/WS server closed.")
  })

  try {
    // Persist data to the Backend
    if (rooms.size > 0) {
      logger.info(`[Shutdown] Persisting ${rooms.size} active rooms...`)
      await persistAllRooms(rooms)
    }

    // disconnect redis
    await syncRedis.disconnect()
    logger.info(`[Shutdown] Redis disconnected`)

    // shutdown gRPC
    if (grpcServer) {
      await new Promise<void>(resolve => {
        grpcServer.tryShutdown(() => {
          logger.info(`[Shutdown] gRPC server gracefully shut down.`)
          resolve()
        })
      })
    }
    // shutdown kafka
    await kafkaService.shutdown()
    logger.info(`[Shutdown] Kafka is gracefully shut down.`)
    logger.debug("[Shutdown] All data saved. Clean exit.")
    clearTimeout(forceExit)
    process.exit(0)
  } catch (err) {
    logger.error({ error: err }, "[Shutdown] Error during cleanup:")
    process.exit(1)
  }
}

// Listen for Ctrl+C (Interrupt) and SIGTERM (Docker)
process.on("SIGINT", () => gracefulShutdown("SIGINT"))
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
