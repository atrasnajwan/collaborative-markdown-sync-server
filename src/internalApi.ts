import { config } from "./config.js";

export type DocumentUpdateDTO = {
  seq: number;
  binary: string; // JSON []byte becomes base64 string
};

export type DocumentState = {
  title: string;
  snapshot: string; // base64
  snapshot_seq: number;
  updates: DocumentUpdateDTO[];
};

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.BACKEND_API_SECRET}`,
  };

  const response = await fetch(`${config.BACKEND_API_URL}${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json() as { message?: string };
    throw new Error(error?.message || 'An error occurred');
  }

  return response.json() as T
}


export async function fetchLastDocumentState(docId: string): Promise<DocumentState> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  return request<DocumentState>(`/internal/documents/${docId}/last-state`, { headers });
}

export async function postDocumentUpdate(
  docId: string,
  update: Uint8Array,
  userId?: string,
): Promise<void> {
  const body = Buffer.from(update);

  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  };
  
  if (userId) {
    headers["x-user-id"] = userId;
  }

  return request<void>(`/internal/documents/${docId}/update`, {
    method: 'POST',
    headers,
    body,
  });
}

