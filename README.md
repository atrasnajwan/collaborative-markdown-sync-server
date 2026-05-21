# Collaborative Markdown Sync Server

WebSocket Yjs sync + awareness server that keeps a Y.Doc in memory per room and forwards updates to a backend via Kafka or HTTP/gRPC.

## Quick links:

- Server bootstrap: [`startServer`](src/server.ts) — [src/index.ts](src/index.ts)
- Configuration: [`config`](src/config/config.ts)
- Internal API: [`handleInternalAPI`](src/api/handlers.ts) — [src/services/internal.ts](src/services/internal.ts)
- Kafka integration: [`kafkaService`](src/services/kafka.ts)

## What it does

- Accept WebSocket connections from clients (auth via `?token=JWT`)
- Speak Yjs sync + awareness protocols
- Keep Y.Doc in memory per room; hydrate from backend on first access
- Broadcast document and awareness updates to all peers in the same room
- Enforce roles (owner/editor can edit; viewer read-only)
- Forward document updates to a backend via Kafka (if available) or HTTP/gRPC

## Responsibilities

- **WebSocket management** — Accept connections on `ws://HOST:PORT/<room>`, parse room and token from URL, route binary messages per connection, and clean up on close/error. One room per URL path; connections are tracked per room in `core/rooms.ts`.
- **Yjs sync protocol** — Handle sync message type (0): apply client updates to the room's in-memory `Y.Doc`, send sync step 2 to new clients, and broadcast document updates to other peers in the room (see `core/yjsProtocol.ts`).
- **Awareness broadcasting** — Handle awareness message types (1, 3): maintain a shared `Awareness` instance per room, apply client awareness updates, broadcast changes to other clients, and send full awareness state on request (see `core/yjsProtocol.ts`, `core/rooms.ts`).
- **Document lifecycle** — Create room (Y.Doc + Awareness) on first connection; hydrate from backend via internal API; apply snapshot + updates to Y.Doc; broadcast and forward updates; destroy idle rooms after `ROOM_TTL_MS`; on shutdown, persist all room states as snapshots to the backend (see `core/rooms.ts`, `core/persistence.ts`, `server.ts`).
- **Message forwarding** — Forward document updates and snapshots via Kafka message queue (when configured) for event-driven architectures, or fall back to HTTP/gRPC endpoints (see `services/kafka.ts`, `core/persistence.ts`).

## Rooms / URLs

- `ws://localhost:8787/<room>` → room name is the path (e.g. `my-room` or `doc-abc123` for document IDs).
- `ws://localhost:8787/` → room `"default"`.
- Auth required: `ws://host:port/<room>?token=JWT_HERE`

## Scalability

The server supports **horizontal scaling** using Redis pub/sub. When `REDIS_ADDRESS` is set, each instance will connect to Redis and relay document and awareness updates through per-room channels. This allows clients attached to different nodes to stay in sync while each node continues to maintain its own in-memory copy of a room's `Y.Doc`.

Detailed design, configuration examples, and implementation notes are covered in the separate [Redis scaling guide](./REDIS-SCALING.md).

## Message Queue Integration

The server can forward document updates and snapshots to a Kafka message queue. When `KAFKA_BROKERS` is configured, the server will:

- Publish document updates to the `document.events` topic as `document.updated` events
- Publish document snapshots to the `document.events` topic as `document.snapshot` events
- Subscribe to the `notification-events` topic to handle permission changes and document deletions

If Kafka is not configured, the server falls back to HTTP/gRPC endpoints for sending updates to the backend.

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

## Kafka setup for local testing

A helper `kafka-docker-compose.yaml` compose file is included for running Kafka locally in KRaft mode:

```sh
# from repo root
docker compose -f kafka-docker-compose.yaml up --build
```

Then configure the server with:

```sh
KAFKA_BROKERS=localhost:9092 pnpm run dev
```

## HTTP endpoints

- Health: GET /healthz
- Internal API prefix: /internal/
  - Implemented by [handleInternalAPI](src/api/handlers.ts)
  - Requires header `x-internal-secret` (see [config](src/config/config.ts))

## gRPC access for internal API

The same internal API exposed over HTTP can also be served via gRPC on a
separate port. Set the `GRPC_PORT` environment variable to the
port you want the server to listen on (e.g. `50051`). If the value is `0` or
unset the gRPC service is disabled and only the HTTP endpoints will be
available. Both transports may be enabled simultaneously for backward
compatibility with existing callers.

## Environment variables (see [config](src/config/config.ts))

- PORT (default 8787)
- HOST (default 0.0.0.0)
- BACKEND_API_GRPC_ADDRESS — if set, address of backend gRPC service used for internal API calls (takes precedence over HTTP)
- BACKEND_API_URL — legacy HTTP base URL; still supported when gRPC address is empty
- BACKEND_API_SECRET — used by internal client requests to backend
- INTERNAL_SECRET — required header for /internal/ requests
- JWT_SECRET — used to verify client tokens
- REDIS_ADDRESS — if set, enables Redis pub/sub for horizontally scaled deployments (see [Redis scaling guide](./REDIS-SCALING.md))
- KAFKA_BROKERS — comma-separated list of Kafka broker addresses; if set, enables Kafka message queue integration for event forwarding
- FORWARD_DEBOUNCE_MS — debounce merging updates before forwarding (default 0)
- ROOM_TTL_MS — idle-room TTL in ms (default 600000)
- GRPC_PORT — port for gRPC internal API server; if 0 or unset, gRPC is disabled

## Backend payloads

The internal API may be accessed either via gRPC or over HTTP. When
`BACKEND_API_GRPC_ADDRESS` is set the server will use the gRPC service defined in
`proto/server.proto`; otherwise it will fall back to the legacy HTTP endpoints
on `BACKEND_API_URL` (`/internal/documents/...`).

Client helper functions in [`src/services/internal.ts`](src/services/internal.ts) make this choice transparently, preferring gRPC but sending HTTP requests when no gRPC address is configured. Raw Yjs updates and snapshots are still sent as byte buffers.

### Kafka Message Formats

When using Kafka for message forwarding, the following event types are published:

**Document Updates** (`document.updated`):
```json
{
  "event_id": "uuid",
  "type": "document.updated",
  "document_id": 123,
  "user_id": 456,
  "timestamp": 1234567890,
  "data": "base64-encoded-yjs-update"
}
```

**Document Snapshots** (`document.snapshot`):
```json
{
  "event_id": "uuid",
  "type": "document.snapshot",
  "document_id": 123,
  "timestamp": 1234567890,
  "data": "base64-encoded-yjs-state"
}
```

The server also subscribes to incoming notifications from the backend:

**Permission Changes** (`document.role_updated`):
```json
{
  "event_id": "uuid",
  "type": "document.role_updated",
  "document_id": 123,
  "affected_user_id": 456,
  "role": "editor",
  "timestamp": 1234567890
}
```

**Document Deletion** (`document.deleted`):
```json
{
  "event_id": "uuid",
  "type": "document.deleted",
  "document_id": 123,
  "timestamp": 1234567890
}
```

> The HTTP endpoints remain available for backward compatibility

<br>

> Notes
>
> - Rooms are hydrated from backend on first access; sync starts after hydration completes.
> - Permissions are fetched per-connection from the backend (see [src/core/rooms.ts](src/core/rooms.ts)).
> - When Kafka is configured, message forwarding prioritizes the Kafka producer; HTTP/gRPC is used as fallback.
