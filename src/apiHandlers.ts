import http from "http"
import { Room } from "./types.js"
import { config } from "./config.js"
import { logger } from "./logger.js"
import { getLatestDocState, handleDocumentDeleted, handleUserRoleChanged } from "./rooms.js"
import { syncRedis } from "./redis.js"
import { randomUUID } from "node:crypto"

const sendJSON = (res: http.ServerResponse, status: number, data?: any, isBinary: boolean = false) => {
  res.writeHead(status, { "Content-Type": isBinary ? "application/octet-stream" : "application/json" })
  res.end(data ? (isBinary ? data : JSON.stringify(data)) : null)
}

const getBody = (req: http.IncomingMessage): Promise<string> => {
  return new Promise(resolve => {
    let body = ""
    req.on("data", chunk => (body += chunk))
    req.on("end", () => resolve(body))
  })
}


// helper functions used by both HTTP and gRPC servers

export class DocumentNotFoundError extends Error {}

export async function fetchRoomState(
  docId: string,
  rooms: Map<string, Room>,
): Promise<Buffer> {
  const roomName = `doc-${docId}`
  try {
    let binary = null
    if (syncRedis.isEnabled) {
      const responseChannel = `snapshot:response:${randomUUID()}`
      syncRedis.publishSnapshotRequest(roomName, responseChannel)
      binary = await syncRedis.subscribeSnapshotResponse(responseChannel)
    } else {
      const room = rooms.get(roomName)
      if (!room) throw new DocumentNotFoundError("Document not found")
      binary = getLatestDocState(room)
    }
    logger.debug({ docId, binary: binary.length }, "Snapshot response")
    return binary
  } catch (err) {
    logger.error({ error: err, docId }, "Failed to fetch last document state")
    throw err
  }
}

export async function deleteDocument(
  docId: string,
): Promise<number> {
  const roomName = `doc-${docId}`
  if (syncRedis.isEnabled) {
    return syncRedis.publishDocumentDeleted(roomName)
  } else {
    return handleDocumentDeleted(roomName)
  }
}

export async function changeUserPermission(
  docId: string,
  user_id: string,
  role: string,
): Promise<number> {
  const roomName = `doc-${docId}`
  if (syncRedis.isEnabled) {
    return syncRedis.publishRoleChanged(roomName, user_id, role)
  } else {
    return handleUserRoleChanged(roomName, user_id, role)
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
  if (req.headers["x-internal-secret"] !== config.INTERNAL_SECRET) {
    res.writeHead(403)
    return res.end()
  }

  const parts = url.split("/")
  const docId = parts[3]
  const action = parts[4]

  // GET /internal/documents/:id/state
  if (method === "GET" && action === "state") {
    try {
      const binary = await fetchRoomState(docId, rooms)
      return sendJSON(res, 200, binary, true)
    } catch (err) {
      if ((err as any).message === "Document not found") {
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
      const updated = await changeUserPermission(docId, user_id, role)
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
