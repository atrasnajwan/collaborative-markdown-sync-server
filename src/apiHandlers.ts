import http from "http"
import { Room } from "./types.js"
import { config } from "./config.js"
import { logger } from "./logger.js"
import { getLatestDocState, handleDocumentDeleted, handleUserRoleChanged } from "./rooms.js"
import { syncRedis } from "./redis.js"
import { randomUUID } from "node:crypto"

const sendJSON = (res: http.ServerResponse, status: number, data?: any) => {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(data ? JSON.stringify(data) : null)
}

const getBody = (req: http.IncomingMessage): Promise<string> => {
  return new Promise(resolve => {
    let body = ""
    req.on("data", chunk => (body += chunk))
    req.on("end", () => resolve(body))
  })
}

export async function handleInternalAPI(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rooms: Map<string, Room>,
) {
  const { method, url } = req
  if (!url) return

  // Auth
  if (req.headers["x-internal-secret"] !== config.INTERNAL_SECRET) {
    res.writeHead(403)
    return res.end()
  }

  const parts = url.split("/")
  const docId = parts[3]
  const action = parts[4]
  const roomName = `doc-${docId}`

  // GET /internal/documents/:id/state
  if (method === "GET" && action === "state") {
    try {
      let binaryStr = ""
      if (syncRedis.isEnabled) {
        const responseChannel = `snapshot:response:${randomUUID()}`
        syncRedis.publishSnapshotRequest(roomName, responseChannel)
        binaryStr = (await syncRedis.subscribeSnapshotResponse(responseChannel)).toString("base64")
      } else {
        const room = rooms.get(roomName)
        if (!room) return sendJSON(res, 404, { error: "Document not found" })
        binaryStr = getLatestDocState(room).toString("base64")
      }
      logger.debug({ docId, binaryStr: binaryStr.length }, "Snapshot response")
      return sendJSON(res, 200, { binary: binaryStr })
    } catch (err) {
      logger.error({ error: err, docId }, "Failed to fetch last document state")
      return sendJSON(res, 500, { error: "Failed to fetch last document state" })
    }
  }

  // DELETE /internal/documents/:id
  if (method === "DELETE" && !action) {
    try {
      await handleDocumentDeleted(roomName)
      let updated = 0
      if (syncRedis.isEnabled) {
        updated = await syncRedis.publishDocumentDeleted(roomName)
      } else {
        updated = await handleDocumentDeleted(roomName)
      }
      logger.debug({ updated }, "Notification sent")
      return sendJSON(res, 204)
    } catch (wsError) {
      logger.error({ error: wsError }, "Failed to notify client of document deleted")
      return sendJSON(res, 500, { error: "Failed to notify connected clients" })
    }
  }

  // PUT /internal/documents/:id/permission
  if (method === "PUT" && action === "permission") {
    const body = await getBody(req)
    const { user_id, role } = JSON.parse(body)

    try {
      let updated = 0
      if (syncRedis.isEnabled) {
        updated = await syncRedis.publishRoleChanged(roomName, user_id, role)
      } else {
        updated = await handleUserRoleChanged(roomName, user_id, role)
      }
      logger.debug({ updated }, "Notification sent")
      return sendJSON(res, 200, {
        ok: true,
        updated,
      })
    } catch (wsError) {
      logger.error({ error: wsError, user_id }, "Failed to notify client of permission change")
      return sendJSON(res, 500, { error: "Failed to notify connected clients" })
    }
  }

  sendJSON(res, 404)
}
