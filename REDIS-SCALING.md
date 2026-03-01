# Horizontal Scaling with Redis Pub/Sub

A single server instance holds an in‑memory `Y.Doc` for each active room. In a production environment it is desirable to run multiple instances behind a load‑balancer so that clients connected to different nodes stay in sync. Redis pub/sub allows all nodes to broadcast document and awareness updates for a room, ensuring eventual consistency across the cluster.

## How It Works

Each instance maintains the normal in‑memory state; Redis doesn’t replace the documents but merely relays updates between peers.

### Channels

For every room name `R` the server uses the following Redis channels:

- `sync:doc:R` – document updates (`Y.applyUpdate`) are published here.
- `sync:awareness:R` – awareness updates (cursor/selection data) are published here.
- `snapshot:doc:R` – snapshot request/response channel used when a new node needs the full document state from one of the existing owners.
- `notification:room:R` – miscellaneous events such as role changes or document deletions.

A new instance first connects both a publisher and subscriber client. When a room is created locally, the server calls `syncRedis.subscribeRoom(room)` which
in turn registers callbacks for each channel. Published updates are tagged with `origin === "redis"` to avoid re‑emitting the same message again.

Snapshot requests allow an instance that has just received a connection for a room to ask peers for the latest full state. The first node in the cluster for
a given room responsds to `snapshot:doc:R` by sending the current document state to a unique response channel.

Notifications are JSON payloads and currently carry two types:
`role-changed` and `document-deleted`. Hooks in `rooms.ts` handle these events and update in‑memory state accordingly.

### Locks

During room destruction/flush the code acquires a short‑lived distributed lock (`lock:forward:R`) implemented with a `SET NX PX` command. This prevents two
servers from forwarding the same updates to the backend simultaneously.

## Configuration

Enable Redis by providing a valid `REDIS_ADDRESS` environment variable (URI or `host:port`). The server will log in **debug** mode whether it successfully
connected or is running in single-server mode.

```bash
export REDIS_ADDRESS="redis://localhost:6379"
# other env vars as normal
pnpm run dev
```

No other configuration is required; the Redis client automatically reconnects with backoff and logs errors.

### Local testing

A `multi-server.yaml` compose file is checked into the repository for experimentation (see the main README for details). It spins up three replicas, nginx and Redis so you can run a small cluster on your machine and observe how updates flow between nodes.

## Considerations

- **Failure Modes**: if Redis is unavailable the server continues in single‑node mode (`isEnabled === false`) and clients connected only to that instance will  still work. Updates originating from another node will not be received until Redis reconnects.
- **Performance**: message size is identical to the Yjs updates that would be broadcast over WebSocket; Redis is typically strong enough for thousands of
  ops per second, but monitor latency if you have heavy traffic.
- **Security**: Redis authentication (ACLs/password) is managed via the connection string passed in `REDIS_ADDRESS`.

---

For an overview of the server and other features, refer to the main
[README](./README.md).