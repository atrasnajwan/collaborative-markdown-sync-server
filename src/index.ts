/**
 * Yjs WS bridge server
 *
 * - Rooms are identified by URL path: ws://host:PORT/<room>
 * - Keeps Y.Doc and awareness in-memory per room
 * - Speaks Yjs sync + awareness protocols
 * - Broadcasts updates to peers in the room
 * - Forwards doc updates to API via HTTP POST
 */

import { rooms } from "./rooms.js";
import { persistAllRooms, startServer } from "./server.js";

const server = startServer();

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[${signal}] Received. Starting graceful shutdown...`);

  // Set a "Force Kill" timeout 
  // If the API is down, we don't want the process to hang forever.
  const forceExit = setTimeout(() => {
    console.error("[Shutdown] Timed out! Forcefully exiting.");
    process.exit(1);
  }, 10000); // 10 seconds

  // Stop accepting new connections
  server.close(() => {
    console.log("[Shutdown] HTTP/WS server closed.");
  });

  try {
    // 3. Persist data to the Go Backend
    if (rooms.size > 0) {
      console.log(`[Shutdown] Persisting ${rooms.size} active rooms...`);
      await persistAllRooms();
    }
    
    console.log("[Shutdown] All data saved. Clean exit.");
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    console.error("[Shutdown] Error during cleanup:", err);
    process.exit(1);
  }
}

// Listen for Ctrl+C (Interrupt) and SIGTERM (Docker)
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));