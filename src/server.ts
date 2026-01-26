import { createServer } from "node:http";

import { WebSocketServer } from "ws";

import { config } from "./config.js";

export function startServer() {
  const httpServer = createServer();

  const wss = new WebSocketServer({ server: httpServer });

  httpServer.listen(config.PORT, config.HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`listening on http://${config.HOST}:${config.PORT}`);
  });
}

