/* eslint-disable @typescript-eslint/no-empty-object-type */
import grpc from "@grpc/grpc-js"
import protoLoader from "@grpc/proto-loader"

import { config } from "../config/config.js"
import { fetchRoomState, rooms } from "../core/rooms.js"
import { logger } from "../services/logger.js"
import { authenticateGrpcCall } from "../core/auth.js"
import { deleteDocument, DocumentNotFoundError } from "../core/documents.js"
import { changeUserPermission } from "../core/users.js"

interface SyncServerPackage extends grpc.GrpcObject {
  syncserver: {
    SyncServerInternal: grpc.ServiceClientConstructor
  }
}

interface GrpcDocRequest {
  id: number
}

interface GrpcPermissionChangeRequest {
  doc_id: number
  user_id: number
  role: string
}

const PROTO_PATH = new URL("../proto/server.proto", import.meta.url).pathname

export function startGrpcServer(): grpc.Server | null {
  if (!config.GRPC_PORT) {
    logger.debug("gRPC internal API disabled (no port configured)")
    return null
  }

  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })
  const grpcObj = grpc.loadPackageDefinition(packageDef) as SyncServerPackage
  const SyncServerInternal = grpcObj.syncserver.SyncServerInternal

  const server = new grpc.Server()

  server.addService(SyncServerInternal.service, {
    async PostSnapshot(
      call: grpc.ServerUnaryCall<GrpcDocRequest, {}>,
      callback: grpc.sendUnaryData<{}>
    ) {
      if (!authenticateGrpcCall(call)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, details: "unauthorized" })
      }

      const docId = String(call.request.id || "")
      try {
        logger.debug("PostSnapshot called via gRPC")
        await fetchRoomState(docId, rooms)
        callback(null, {})
      } catch (err) {
        // prefer checking for the dedicated error class
        if (err instanceof DocumentNotFoundError) {
          return callback({ code: grpc.status.NOT_FOUND, details: "document not found" })
        }
        logger.error({ error: err, docId }, "PostSnapshot gRPC handler error")
        return callback({ code: grpc.status.INTERNAL, details: "internal error" })
      }
    },

    async DeleteDocument(
      call: grpc.ServerUnaryCall<GrpcDocRequest, {}>,
      callback: grpc.sendUnaryData<{}>
    ) {
      if (!authenticateGrpcCall(call)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, details: "unauthorized" })
      }

      const docId = String(call.request.id || "")
      try {
        logger.debug("DeleteDocument called via gRPC")
        await deleteDocument(docId)
        callback(null, {})
      } catch (err) {
        logger.error({ error: err, docId }, "DeleteDocument gRPC handler error")
        callback({ code: grpc.status.INTERNAL, details: "internal error" })
      }
    },

    async PermissionChanged(
      call: grpc.ServerUnaryCall<GrpcPermissionChangeRequest, {}>,
      callback: grpc.sendUnaryData<{}>,
    ) {
      if (!authenticateGrpcCall(call)) {
        return callback({ code: grpc.status.PERMISSION_DENIED, details: "unauthorized" })
      }

      const { doc_id, user_id, role } = call.request
      try {
        logger.debug("PermissionChanged called via gRPC")
        await changeUserPermission(String(doc_id), String(user_id), String(role))
        callback(null, {})
      } catch (err) {
        logger.error({ error: err, docId: doc_id }, "PermissionChanged gRPC handler error")
        callback({ code: grpc.status.INTERNAL, details: "internal error" })
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
