import http from "http"
import { Room } from "../types/room.js"
import { logger } from "../services/logger.js"
import { syncRedis } from "../services/redis.js"
import { authenticateApiCall } from "../core/auth.js"
import { DocumentNotFoundError, handleDocumentDeleted } from "../core/documents.js"
import { changeUserPermission, handleUserRoleChanged } from "../core/users.js"
import { fetchRoomState } from "../core/rooms.js"

const sendJSON = (
  res: http.ServerResponse,
  status: number,
  data?: object,
  isBinary: boolean = false,
) => {
  res.writeHead(status, {
    "Content-Type": isBinary ? "application/octet-stream" : "application/json",
  })
  res.end(data ? (isBinary ? data : JSON.stringify(data)) : null)
}

const getBody = (req: http.IncomingMessage): Promise<string> => {
  return new Promise(resolve => {
    let body = ""
    req.on("data", chunk => (body += chunk))
    req.on("end", () => resolve(body))
  })
}

export async function deleteDocument(docId: string): Promise<number> {
  const roomName = `doc-${docId}`
  if (syncRedis.isEnabled) {
    return syncRedis.publishDocumentDeleted(roomName)
  } else {
    return handleDocumentDeleted(roomName)
  }
}

export async function handleInternalAPI(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rooms: Map<string, Room>,
) {
  const { method, url } = req
  if (!url) return

  // Auth
  if (!authenticateApiCall(req.headers)) {
    res.writeHead(403)
    return res.end()
  }

  const parts = url.split("/")
  const docId = parts[3]
  const action = parts[4]

  
  // POST /internal/documents/:id/snapshot
  if (method === "POST" && action === "snapshot") {
    try {
      await fetchRoomState(docId, rooms)
      return sendJSON(res, 204)
    } catch (err) {
      if (err as DocumentNotFoundError) {
        return sendJSON(res, 404, { error: "Document not found" })
      }
      return sendJSON(res, 500, { error: "Failed to fetch last document state" })
    }
  }

  // DELETE /internal/documents/:id
  if (method === "DELETE" && !action) {
    try {
      const updated = await deleteDocument(docId)
      logger.debug({ updated }, "Notification sent")
      return sendJSON(res, 204)
    } catch (error) {
      logger.error({ error }, "Failed to notify client of document deleted")
      return sendJSON(res, 500, { error: "Failed to notify connected clients" })
    }
  }

  // PUT /internal/documents/:id/permission
  if (method === "PUT" && action === "permission") {
    const body = await getBody(req)
    const { user_id, role } = JSON.parse(body)

    try {
      const updated = await changeUserPermission(docId, user_id, role)
      logger.debug({ updated }, "Notification sent")
      return sendJSON(res, 200, {
        ok: true,
        updated,
      })
    } catch (error) {
      logger.error({ error, user_id }, "Failed to notify client of permission change")
      return sendJSON(res, 500, { error: "Failed to notify connected clients" })
    }
  }

  sendJSON(res, 404)
}
