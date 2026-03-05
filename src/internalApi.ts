import { config } from "./config.js"
import { UserRole } from "./types.js"
import grpc, { GrpcObject } from "@grpc/grpc-js"
import protoLoader from "@grpc/proto-loader"


export type DocumentUpdateDTO = {
  seq: number
  binary: string // base64-encoded bytes
}

export type DocumentState = {
  snapshot: string // base64
  snapshot_seq: number
  updates: DocumentUpdateDTO[]
}

type UserRoleResponse = {
  role: UserRole
}

function useGrpc(): boolean {
  return !!config.BACKEND_API_GRPC_ADDRESS
}

// ----------------------------------------------------------
// HTTP helpers
// ----------------------------------------------------------

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.BACKEND_API_SECRET}`,
  }

  if (!config.BACKEND_API_URL) {
    throw new Error("BACKEND_API_URL not configured")
  }

  const response = await fetch(`${config.BACKEND_API_URL}${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  })

  if (!response.ok) {
    const error = (await response.json()) as { message?: string }
    throw new Error(error?.message || "An error occurred")
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return {} as T
  }

  return (await response.json()) as T
}

// ----------------------------------------------------------
// gRPC setup
// ----------------------------------------------------------

let grpcClient: any = null
function ensureGrpcClient(): any {
  if (grpcClient || !useGrpc()) return grpcClient

  // load proto definition dynamically. using URL relative to this file so it continues
  // to work after the project is compiled into `dist/`.
  const PROTO_PATH = new URL("../proto/internal.proto", import.meta.url).pathname
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })

  const grpcObj: any = grpc.loadPackageDefinition(packageDef)
  const InternalService = grpcObj.internalpb.InternalService as grpc.ServiceClientConstructor
  grpcClient = new InternalService(
    config.BACKEND_API_GRPC_ADDRESS,
    grpc.credentials.createInsecure(),
  )
  return grpcClient
}

function makeMetadata(): grpc.Metadata {
  const meta = new grpc.Metadata()
  // auth
  meta.set("x-internal-secret", config.BACKEND_API_SECRET)
  return meta
}

function toBase64(buffer: Buffer | Uint8Array | undefined): string {
  if (!buffer) return ""
  return Buffer.from(buffer).toString("base64")
}

// ----------------------------------------------------------
// exported helpers
// ----------------------------------------------------------

export async function fetchLastDocumentState(docId: string): Promise<DocumentState> {
  if (useGrpc()) {
    return new Promise((resolve, reject) => {
      ensureGrpcClient().GetDocumentState(
        { id: Number(docId) },
        makeMetadata(),
        (err: any, resp: any) => {
          if (err) return reject(err)
          const updates: DocumentUpdateDTO[] = (resp.updates || []).map((u: any) => ({
            seq: Number(u.seq),
            binary: toBase64(u.binary),
          }))
          resolve({
            snapshot: toBase64(resp.snapshot),
            snapshot_seq: Number(resp.snapshot_seq),
            updates,
          })
        },
      )
    })
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  }
  return request<DocumentState>(`/internal/documents/${docId}/last-state`, { headers })
}

export async function postDocumentUpdate(
  docId: string,
  update: Uint8Array,
  userId?: string,
): Promise<void> {
  if (useGrpc()) {
    return new Promise((resolve, reject) => {
      const req: any = {
        doc_id: Number(docId),
        update: Buffer.from(update),
      }
      if (userId) {
        req.user_id = Number(userId)
      }
      ensureGrpcClient().CreateUpdate(req, makeMetadata(), (err: any) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }

  const body = Buffer.from(update)
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  }
  if (userId) {
    headers["x-user-id"] = userId
  }
  return request<void>(`/internal/documents/${docId}/update`, {
    method: "POST",
    headers,
    body,
  })
}

export async function postDocumentSnapshot(docId: string, state: Uint8Array): Promise<void> {
  if (useGrpc()) {
    return new Promise((resolve, reject) => {
      ensureGrpcClient().CreateSnapshot(
        { doc_id: Number(docId), snapshot: Buffer.from(state) },
        makeMetadata(),
        (err: any) => {
          if (err) return reject(err)
          resolve()
        },
      )
    })
  }

  const body = Buffer.from(state)
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  }
  return request<void>(`/internal/documents/${docId}/snapshot`, {
    method: "POST",
    headers,
    body,
  })
}

export async function fetchUserRole(docId: string, userId: string): Promise<UserRoleResponse> {
  if (useGrpc()) {
    return new Promise((resolve, reject) => {
      ensureGrpcClient().GetUserRole(
        { doc_id: Number(docId), user_id: Number(userId) },
        makeMetadata(),
        (err: any, resp: any) => {
          if (err) return reject(err)
          resolve(resp)
        },
      )
    })
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  }
  return request<UserRoleResponse>(`/internal/documents/${docId}/permission?user_id=${userId}`, {
    headers,
  })
}
