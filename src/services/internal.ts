import { config } from "../config/config.js"
import {
  createDocumentSnapshot,
  createDocumentUpdate,
  getDocumentState,
  getUserRole,
  useGrpc,
} from "../grpc/client.js"
import { DocumentState } from "../types/document.js"
import { UserRoleResponse } from "../types/user.js"

// http helper
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

export async function fetchLastDocumentState(docId: number): Promise<DocumentState> {
  if (useGrpc()) {
    return getDocumentState(docId)
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  }
  return request<DocumentState>(`/internal/documents/${docId}/last-state`, { headers })
}

export async function postDocumentUpdate(
  docId: number,
  update: Uint8Array,
  userId?: number,
): Promise<void> {
  if (useGrpc()) {
    return createDocumentUpdate(docId, update, userId)
  }

  const body = Buffer.from(update)
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  }
  if (userId) {
    headers["x-user-id"] = String(userId)
  }
  return request<void>(`/internal/documents/${docId}/update`, {
    method: "POST",
    headers,
    body,
  })
}

export async function postDocumentSnapshot(docId: number, state: Uint8Array): Promise<void> {
  if (useGrpc()) {
    return createDocumentSnapshot(docId, state)
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

export async function fetchUserRole(docId: number, userId: number): Promise<UserRoleResponse> {
  if (useGrpc()) {
    return getUserRole(docId, userId)
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  }
  return request<UserRoleResponse>(`/internal/documents/${docId}/permission?user_id=${userId}`, {
    headers,
  })
}
