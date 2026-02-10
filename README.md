# Collaborative Markdown Sync Server

WebSocket Yjs sync + awareness server that keeps a Y.Doc in memory per room and (optionally) forwards updates to a backend.

## Quick links:

- Server bootstrap: [`startServer`](src/server.ts) — [src/index.ts](src/index.ts)
- Configuration: [`config`](src/config.ts)
- Internal API: [`handleInternalAPI`](src/apiHandlers.ts) — [src/internalApi.ts](src/internalApi.ts)

## What it does

- Accept WebSocket connections from clients
- Speak Yjs sync + awareness protocols
- Keep Y.Doc in memory per room
- Broadcast updates to all peers in the same room
- Optionally forward updates to a backend via HTTP

## Rooms / URLs

- `ws://localhost:8787/my-room` → room `"my-room"`
- `ws://localhost:8787/` → room `"default"`
- Supply auth via query: `ws://host:port/room?token=JWT_HERE`

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
