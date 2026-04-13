import http from "http"
import { Room } from "./types.js"
import { config } from "./config.js"
import { logger } from "./logger.js"
import { getLatestDocState, handleDocumentDeleted, handleUserRoleChanged } from "./rooms.js"
import { syncRedis } from "./redis.js"
import { randomUUID } from "node:crypto"
import { KafkaDocMessage } from "./services/types.js"
import { kafkaService } from "./services/kafka.js"

const sendJSON = (
  res: http.ServerResponse,
  status: number,
  data?: any,
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

export class DocumentNotFoundError extends Error { }

export async function fetchRoomState(docId: string, rooms: Map<string, Room>): Promise<void> {
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
    // push message to kafka
    const event: KafkaDocMessage = {
      event_id: randomUUID(),
      type: "document.snapshot",
      document_id: Number(docId),
      timestamp: Date.now(),
      data: Buffer.from(binary).toString("base64"),
    }

    logger.debug({ docId, binary: binary.length }, "Snapshot response")
    return kafkaService.sendMessage("document.sync", [
      {
        key: docId,
        value: JSON.stringify(event),
      },
    ])
  } catch (err) {
    logger.error({ error: err, docId }, "Failed to fetch last document state")
    throw err
  }
}

export async function deleteDocument(docId: string): Promise<number> {
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

  // POST /internal/documents/:id/snapshot
  if (method === "POST" && action === "snapshot") {
    try {
      await fetchRoomState(docId, rooms)
      return sendJSON(res, 204)
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
