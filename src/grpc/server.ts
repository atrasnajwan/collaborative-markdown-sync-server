import grpc from "@grpc/grpc-js"
import protoLoader from "@grpc/proto-loader"

import { config } from "../config/config.js"
import { fetchRoomState, rooms } from "../core/rooms.js"
import { deleteDocument, changeUserPermission } from "../api/handlers.js"
import { logger } from "../services/logger.js"
import { authenticateGrpcCall } from "../core/auth.js"
import { DocumentNotFoundError } from "../core/documents.js"

const PROTO_PATH = new URL("../proto/server.proto", import.meta.url).pathname
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
})

const grpcObj: any = grpc.loadPackageDefinition(packageDef)

const SyncServerInternal = grpcObj.syncserver.SyncServerInternal as grpc.ServiceClientConstructor

export function startGrpcServer(): grpc.Server | null {
  if (!config.GRPC_PORT) {
    logger.debug("gRPC internal API disabled (no port configured)")
    return null
  }

  const server = new grpc.Server()

  server.addService(SyncServerInternal.service, {
    async PostSnapshot(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      if (!authenticateGrpcCall(call)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: "unauthorized" })
      }

      const docId = String(call.request.id || "")
      try {
        logger.debug("PostSnapshot called via gRPC")
        await fetchRoomState(docId, rooms)
        callback(null)
      } catch (err: any) {
        // prefer checking for the dedicated error class
        if (err instanceof DocumentNotFoundError) {
          return callback({ code: grpc.status.NOT_FOUND, message: "document not found" })
        }
        const msg = err && typeof err.message === "string" ? err.message : String(err)
        logger.debug({ errMessage: msg }, "PostSnapshot catch message")
        logger.error({ error: err, docId }, "PostSnapshot gRPC handler error")
        return callback({ code: grpc.status.INTERNAL, message: "internal error" })
      }
    },

    async DeleteDocument(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      if (!authenticateGrpcCall(call)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: "unauthorized" })
      }

      const docId = String(call.request.id || "")
      try {
        logger.debug("DeleteDocument called via gRPC")
        await deleteDocument(docId)
        callback(null, {})
      } catch (err) {
        logger.error({ error: err, docId }, "DeleteDocument gRPC handler error")
        callback({ code: grpc.status.INTERNAL, message: "internal error" })
      }
    },

    async PermissionChanged(
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) {
      if (!authenticateGrpcCall(call)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: "unauthorized" })
      }

      const { doc_id, user_id, role } = call.request
      try {
        logger.debug("PermissionChanged called via gRPC")
        await changeUserPermission(String(doc_id), String(user_id), String(role))
        callback(null, {})
      } catch (err) {
        logger.error({ error: err, docId: doc_id }, "PermissionChanged gRPC handler error")
        callback({ code: grpc.status.INTERNAL, message: "internal error" })
      }
    },
  })

  const address = `0.0.0.0:${config.GRPC_PORT}`
  server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      logger.error({ error: err }, "Failed to bind gRPC server")
      return
    }
    logger.info({ port }, "Internal gRPC API listening")
  })

  return server
}
