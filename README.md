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

## Scalability

The server supports **horizontal scaling** using Redis pub/sub. When `REDIS_ADDRESS` is set, each instance will connect to Redis and relay document and awareness updates through per-room channels. This allows clients attached to different nodes to stay in sync while each node continues to maintain its own in-memory copy of a room’s `Y.Doc`.

Detailed design, configuration examples, and implementation notes are covered in the separate [Redis scaling guide](./REDIS-SCALING.md).

## Run (development)

```sh
pnpm install
pnpm run dev
LOG_LEVEL=debug pnpm run dev // run with log level
```

## Build / Start (production)

```sh
pnpm run build
pnpm start
```

## Docker multi-instance test

A helper `multi-server.yaml` compose file is included for exercising the Redis-based scaling logic locally. It launches three application replicas, an Nginx load‑balancer on port `9000`, and a Redis cache.

To try it out:

```sh
# from repo root
docker compose -f multi-server.yaml up --build
```

Clients can then connect to ws://localhost:9000/<room> and you should see update events propagated across all three nodes.

This configuration is for testing only; in a real deployment you would use a proper orchestration system (k8s, ECS, etc.) and our own load‑balancer.

## HTTP endpoints

- Health: GET /healthz
- Internal API prefix: /internal/
  - Implemented by [handleInternalAPI](src/apiHandlers.ts)
  - Requires header `x-internal-secret` (see [config](src/config.ts))

## gRPC access for internal API

The same internal API exposed over HTTP can also be served via gRPC on a
separate port. Set the `GRPC_PORT` environment variable to the
port you want the server to listen on (e.g. `50051`). If the value is `0` or
unset the gRPC service is disabled and only the HTTP endpoints will be
available. Both transports may be enabled simultaneously for backward
compatibility with existing callers.

## Environment variables (see [config](src/config.ts))

- PORT (default 8787)
- HOST (default 0.0.0.0)
- BACKEND_API_GRPC_ADDRESS — if set, address of backend gRPC service used for internal API calls (takes precedence over HTTP)
- BACKEND_API_URL — legacy HTTP base URL; still supported when gRPC address is empty
- BACKEND_API_SECRET — used by internal client requests to backend
- INTERNAL_SECRET — required header for /internal/ requests
- JWT_SECRET — used to verify client tokens
- REDIS_ADDRESS — if set, enables Redis pub/sub for horizontally scaled deployments (see [Redis scaling guide](./REDIS-SCALING.md))
- FORWARD_DEBOUNCE_MS — debounce merging updates before forwarding (default 0)
- ROOM_TTL_MS — idle-room TTL in ms (default 600000)

## Backend payloads

The internal API may be accessed either via gRPC or over HTTP. When
`BACKEND_API_GRPC_ADDRESS` is set the server will use the gRPC service defined in
`proto/internal.proto`; otherwise it will fall back to the legacy HTTP endpoints
on `BACKEND_API_URL` (`/internal/documents/...`).

Client helper functions in [`src/internalApi.ts`](src/internalApi.ts) make this choice transparently, preferring gRPC but sending HTTP requests when no gRPC address is configured. Raw Yjs updates and snapshots are still sent as byte
buffers.

> The HTTP endpoints remain available for backward compatibility

<br>

> Notes
>
> - Rooms are hydrated from backend on first access; sync starts after hydration completes.
> - Permissions are fetched per-connection from the backend (see [src/rooms.ts](src/rooms.ts)).
