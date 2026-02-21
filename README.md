# Collaborative Markdown Sync Server

WebSocket Yjs sync + awareness server that keeps a Y.Doc in memory per room and (optionally) forwards updates to a backend.

## Quick links:

- Server bootstrap: [`startServer`](src/server.ts) — [src/index.ts](src/index.ts)
- Configuration: [`config`](src/config.ts)
- Internal API: [`handleInternalAPI`](src/apiHandlers.ts) — [src/internalApi.ts](src/internalApi.ts)

## What it does

- Accept WebSocket connections from clients (auth via `?token=JWT`)
- Speak Yjs sync + awareness protocols
- Keep Y.Doc in memory per room; hydrate from backend on first access
- Broadcast document and awareness updates to all peers in the same room
- Enforce roles (owner/editor can edit; viewer read-only)
- Optionally forward document updates to a backend via HTTP

## Responsibilities

- **WebSocket management** — Accept connections on `ws://HOST:PORT/<room>`, parse room and token from URL, route binary messages per connection, and clean up on close/error. One room per URL path; connections are tracked per room in `rooms.ts`.
- **Yjs sync protocol** — Handle sync message type (0): apply client updates to the room’s in-memory `Y.Doc`, send sync step 2 to new clients, and broadcast document updates to other peers in the room (see `yjsProtocol.ts`).
- **Awareness broadcasting** — Handle awareness message types (1, 3): maintain a shared `Awareness` instance per room, apply client awareness updates, broadcast changes to other clients, and send full awareness state on request (see `yjsProtocol.ts`, `rooms.ts`).
- **Document lifecycle** — Create room (Y.Doc + Awareness) on first connection; hydrate from backend via internal API; apply snapshot + updates to Y.Doc; broadcast and optionally forward updates; destroy idle rooms after `ROOM_TTL_MS`; on shutdown, persist all room states as snapshots to the backend (see `rooms.ts`, `persistence.ts`, `server.ts`).

## Rooms / URLs

- `ws://localhost:8787/<room>` → room name is the path (e.g. `my-room` or `doc-abc123` for document IDs).
- `ws://localhost:8787/` → room `"default"`.
- Auth required: `ws://host:port/<room>?token=JWT_HERE`

## Scalability (Redis pub/sub) — *not yet implemented*

Horizontal scaling is planned via **Redis pub/sub**: multiple server instances would share room state by subscribing to per-room channels and publishing document/awareness updates. Each instance would still hold an in-memory Y.Doc per room it serves; Redis would relay updates between instances so that clients connected to different nodes stay in sync. This section will be updated when the feature is implemented.

## Run (development)

```sh
npm install
npm run dev
```

## Build / Start (production)

```sh
npm run build
npm start
```

## HTTP endpoints

- Health: GET /healthz
- Internal API prefix: /internal/
  - Implemented by [handleInternalAPI](src/apiHandlers.ts)
  - Requires header `x-internal-secret` (see [config](src/config.ts))

## Environment variables (see [config](src/config.ts))

- PORT (default 8787)
- HOST (default 0.0.0.0)
- BACKEND_API_URL — if set, forwards updates to this URL
- BACKEND_API_SECRET — used by internal client requests to backend
- INTERNAL_SECRET — required header for /internal/ requests
- JWT_SECRET — used to verify client tokens
- FORWARD_DEBOUNCE_MS — debounce merging updates before forwarding (default 0)
- ROOM_TTL_MS — idle-room TTL in ms (default 600000)

## Backend payloads

- When forwarding updates, the backend receives raw bytes (`application/octet-stream`) at:
  - `POST /internal/documents/:id/update` (see [src/internalApi.ts](src/internalApi.ts))
  - `POST /internal/documents/:id/snapshot` (snapshot on shutdown)
- The internal API also exposes endpoints to read state and manage permissions (see [handleInternalAPI](src/apiHandlers.ts)).

<br>

> Notes
>
> - Rooms are hydrated from backend on first access; sync starts after hydration completes.
> - Permissions are fetched per-connection from the backend (see [src/rooms.ts](src/rooms.ts)).
