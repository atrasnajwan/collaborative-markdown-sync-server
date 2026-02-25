/**
 * Yjs WS bridge server
 *
 * - Rooms are identified by URL path: ws://host:PORT/<room>
 * - Keeps Y.Doc and awareness in-memory per room
 * - Speaks Yjs sync + awareness protocols
 * - Broadcasts updates to peers in the room
 * - Forwards doc updates to API via HTTP POST
 */

import { logger } from "./logger.js"
import { syncRedis } from "./redis.js"
import { rooms } from "./rooms.js"
import { persistAllRooms, startServer } from "./server.js"

try {
  logger.info("Connecting redis...")
  await syncRedis.connect()
} catch (err) {
  logger.error({ error: err }, "[Shutdown] Error during starting redis")
  process.exit(1)
}
const server = startServer()

let isShuttingDown = false

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true

  logger.info(`\n[${signal}] Received. Starting graceful shutdown...`)

  // Set a "Force Kill" timeout
  // If the API is down, we don't want the process to hang forever.
  const forceExit = setTimeout(() => {
    logger.error("[Shutdown] Timed out! Forcefully exiting.")
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
      await persistAllRooms()
    }

    logger.info(`[Shutdown] Disconnecting redis...`)
    await syncRedis.disconnect()

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
