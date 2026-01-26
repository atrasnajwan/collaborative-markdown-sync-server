/**
 * Yjs WS bridge server
 *
 * - Rooms are identified by URL path: ws://host:PORT/<room>
 * - Keeps Y.Doc and awareness in-memory per room
 * - Speaks Yjs sync + awareness protocols
 * - Broadcasts updates to peers in the room
 * - Forwards doc updates to a Go backend via HTTP POST (optional)
 */

import { startServer } from "./server.js";

startServer();

