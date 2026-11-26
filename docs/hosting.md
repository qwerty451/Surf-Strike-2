# Self-hosting with Docker

The self-hosted container image runs the Node 24 game server and serves the SvelteKit web client on one port (`8080`). One URL provides both the playable browser client and the `/ws` WebSocket endpoint without the Vercel `/api/server` discovery route.

## Container image

The root [Dockerfile](../Dockerfile) uses a two-stage build on `node:24-trixie-slim` (glibc 2.41):

1. Build stage installs workspace dependencies, builds `apps/web` with `SURF_ADAPTER=node` (`@sveltejs/adapter-node`), bundles `apps/server/src/index.ts` into `dist/server.mjs` with `esbuild` (`better-sqlite3` external), and exports production `node_modules` for runtime.
2. Runtime stage copies the bundle, the built client handler, and production `node_modules`, creates `/data` and `/data/backups` owned by uid 1000 (`node`), switches to `USER node`, and runs `node dist/server.mjs` directly as PID 1 so `SIGTERM` reaches the process.

The runtime filesystem can be mounted read-only (`--read-only`). The process writes only to `/data` (SQLite database, WAL/SHM files, backups) and `/tmp`.

GitHub Actions ([.github/workflows/image.yml](../.github/workflows/image.yml)) builds and pushes `linux/amd64` images to `ghcr.io/<owner>/surf-strike-2` on pushes to `master`, pushes to `feat/netcode*`, and manual `workflow_dispatch` runs. Images receive a `branch-<slug>-<digest>` tag of at most 128 characters, a `sha-<short>` tag, and `latest` on `master`. The `feat/netcode` branch keeps the exact `netcode` tag used by Flux. The workflow writes the pushed image digest to the GitHub Actions step summary.

## Quick start with `docker run`

Build locally from the repo root or pull from GHCR:

```bash
docker build -t surf-strike-2 .
```

Run with a persistent volume and a read-only root filesystem:

```bash
docker run -d \
  --name surf-strike-2 \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp \
  -p 127.0.0.1:8080:8080 \
  -v surf-strike-data:/data \
  -e TRUST_PROXY=none \
  -e ALLOWED_ORIGINS=same-origin \
  surf-strike-2
```

Open `http://localhost:8080/` in a browser. Self-hosted builds connect directly to `wss://<host>/ws` (or `ws://<host>/ws` over plain HTTP). A `?server=<url>` query parameter overrides the WebSocket target. Sessions are saved by server origin. Only quick tunnels returned by the same Vercel discovery route share a session across restarts. Players with a session saved before this change sign in once to bind it to the correct server.

## Ports and endpoints

The container listens on `HOST:PORT` (default `0.0.0.0:8080`):

| Path | Purpose |
| --- | --- |
| `/` and static assets | SvelteKit client (`@sveltejs/adapter-node` handler) |
| `/ws` | Game WebSocket upgrade endpoint (plain HTTP returns `426 Upgrade Required`) |
| `/health` | Readiness probe (`{ ok, serverId, version, tickRate, map, mode, players }`). Returns HTTP 503 during shutdown. |

## Environment variables

| Variable | Default in image | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | Enables public connection limits and disables `MAP_DURATION_OVERRIDE` |
| `HOST` | `0.0.0.0` | Network interface to bind |
| `PORT` | `8080` | HTTP and WebSocket port (plain server default outside Docker is `27015`) |
| `METRICS_PORT` | unset | Optional Prometheus listener on `127.0.0.1`. Leave unset to disable it. |
| `DB_PATH` | `/data/surf.db` | SQLite database path |
| `ORIGIN` | unset | Public origin used by the SvelteKit handler and the WebSocket `same-origin` check |
| `WEB_HANDLER` | `/app/web/handler.js` | Path to the `@sveltejs/adapter-node` `handler.js`; unset to run API/WS only |
| `ADMIN_USERNAMES` | unset (no admins) | Comma-separated existing admin account usernames, case-insensitive |
| `TRUST_PROXY` | `loopback` | Trusted proxy hops for `CF-Connecting-IP` and `X-Forwarded-For` (see below) |
| `ALLOWED_ORIGINS` | unset (any) | Comma-separated allowed WebSocket `Origin` values plus optional `same-origin` |
| `MAX_PER_IP` | `12` in production or `pnpm host` (`0` in dev) | Maximum connected players per IPv4 address or IPv6 `/64` (`0` disables) |
| `MAX_PENDING_PER_IP` | `4` in production or `pnpm host` (`0` in dev) | Maximum sockets awaiting `hello` per IP or IPv6 `/64` (`0` disables) |
| `MAX_PENDING_CONNECTIONS` | `16` | Maximum open sockets awaiting `hello`, separate from the 32 player slots |
| `HELLO_TIMEOUT_MS` | `5000` | Terminate open sockets that have yet to complete `hello` after this many milliseconds |
| `BACKUP_DIR` | `/data/backups` | Directory for hourly SQLite backups; unset to disable in-process backups |
| `BACKUP_INTERVAL_MS` | `3600000` | Interval between online backups in milliseconds (1 hour) |
| `BACKUP_KEEP` | `48` | Number of newest `surf-<UTC>.db` backups to keep |

## Reverse proxy and hardening

### `TRUST_PROXY`

Visitor IPs drive guest bans and per-IP connection limits. When traffic enters through an in-cluster tunnel or reverse proxy, the TCP peer address is the proxy IP rather than the player's address. Set `TRUST_PROXY` to match your proxy hops so guest bans never ban the proxy:

- `loopback` (default): trust `CF-Connecting-IP` and `X-Forwarded-For` only from `127.0.0.0/8` and `::1`. Matches local `./start.sh` with `cloudflared`.
- `none`: ignore forwarded headers and use direct socket addresses only.
- `private`: trust loopback, RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), CGNAT (`100.64.0.0/10`), link-local, and IPv6 ULA (`fc00::/7`). Use only on a network where every address in those ranges is trusted to supply forwarding headers.
- `cf:<list>`: trust only `CF-Connecting-IP` from explicit peer IPs or CIDRs. Use `TRUST_PROXY=cf:10.42.0.0/16` when cloudflared pods are in that range. A trusted peer with a missing or invalid visitor IP receives HTTP 403 at the WebSocket upgrade. Any direct peer outside the list is identified by its socket address.
- Explicit IP or CIDR list: comma-separated entries such as `10.42.0.0/16,127.0.0.1` or `loopback,fd00::/8`.

When `X-Forwarded-For` is used, the server walks hops right-to-left and picks the first untrusted IP, ignoring client-spoofed entries on the left. Trusted proxy addresses and loopback addresses are never returned as visitor IPs. With the legacy trust modes, unknown visitor IPs share one bucket for the per-IP connection caps. In Kubernetes, apply a NetworkPolicy that limits ingress to cloudflared pods so other pods in the trusted CIDR cannot supply visitor headers.

### `ALLOWED_ORIGINS`

Set `ALLOWED_ORIGINS=same-origin` when the game and page share an origin. Behind cloudflared, set `ORIGIN` to the public HTTPS origin, such as `https://surf.example.com`. With `ORIGIN` unset, the server derives the origin from the request host and connection scheme. If the browser page is hosted separately, add its origin to `ALLOWED_ORIGINS`. For Vite, list `http://localhost:5173` and, if used, `http://127.0.0.1:5173` or the origin of your custom dev port. Disallowed or missing `Origin` headers receive HTTP 403. Leave the allow-list unset for local bot tools that omit `Origin`.

### Admin accounts

Provision the first admin while the service is private. With `ADMIN_USERNAMES` unset, start against the production PVC with access limited to you, for example with a localhost bind or a Kubernetes port-forward before enabling public ingress. Register the intended username and verify that you can sign in. Set `ADMIN_USERNAMES` to that existing username and restart with the same PVC before enabling public access. For an existing public database, verify the account owner before granting admin rights. Configured admin usernames are reserved during public registration.

### Pre-hello limits and shutdown

The HTTP upgrade checks the global pending cap (`MAX_PENDING_CONNECTIONS=16`) and returns 503 when it is full. The pending cap per IP (`MAX_PENDING_PER_IP=4` on public hosts) returns 429. Connections that exceed `HELLO_TIMEOUT_MS=5000` are terminated and keep their pending slot until they close. The active player limit per IP defaults to 12 on public hosts. If only the lobby is full, a client within the pending limits can complete the upgrade and gets a `full` frame followed by close code 4003. The web client waits 60 seconds before retrying.

After hello, the server uses its WebSocket control pings to detect dead connections. It terminates a connection after ten seconds without a matching pong. Players also time out after ten seconds without a state update or game message. Spectators only need to answer the transport pings. Closing the socket frees the player's lobby and per-IP slots.

On `SIGTERM` or `SIGINT`, `/health` and new upgrade requests immediately return HTTP 503 while the listener drains. `pnpm host` starts draining before it clears discovery and leaves the tunnel up until the game server closes. The server stops lobby timers, flushes account playtime and economy state, sends WebSocket close code `1001` to all clients, waits up to 2 seconds for close frames to flush, stops any in-flight backup, closes the HTTP server, and closes SQLite cleanly within 5 seconds.

## Metrics

Set `METRICS_PORT` to scrape `http://127.0.0.1:<port>/metrics` from the same host or pod. Leave it unset if you have no local scraper. The public web listener returns 404 for `/metrics`, and the container service forwards only the game port. Metrics include

- Lobby occupancy: `surf_players`, `surf_pending_connections`, `surf_max_players`
- Event-loop delay (`perf_hooks.monitorEventLoopDelay`): `surf_event_loop_delay_p50_ms`, `surf_event_loop_delay_p99_ms`, `surf_event_loop_delay_max_ms`
- Tick lateness: `surf_snapshot_tick_lateness_{p50,p99,max}_ms`, `surf_snapshot_ticks_total`, `surf_mode_tick_lateness_{p50,p99,max}_ms`, `surf_mode_ticks_total`
- Network throughput and backpressure: `surf_bytes_sent_total`, `surf_bytes_sent_per_second`, `surf_frames_dropped_total`, `surf_socket_buffered_bytes_max`
- Process health: `process_resident_memory_bytes`, `process_uptime_seconds`

## Volumes and backups

Mount `/data` on local persistent storage (not NFS, which breaks SQLite WAL locking). On Kubernetes, run a single replica with `strategy: Recreate` and a PVC backed by a PersistentVolume with the `Retain` reclaim policy. Set the pod security context to `fsGroup: 1000` and verify that the `node` user (uid 1000) can write to `/data`. For storage drivers that do not apply `fsGroup`, prepare the volume ownership before starting the pod.

Backups run in-process using `better-sqlite3`'s `db.backup()` API rather than `cp` or a separate Kubernetes CronJob:

- Copying a live WAL file with `cp` can capture a mid-write state and corrupt the copy.
- A separate CronJob pod would consume extra memory and contend with a `ReadWriteOnce` volume mount.
- `db.backup()` copies pages incrementally without blocking the 64-tick event loop, writes to `surf-<YYYYMMDDTHHMMSSZ>.db.tmp`, renames atomically to `/data/backups/surf-<YYYYMMDDTHHMMSSZ>.db`, and prunes older snapshots so the newest 48 (2 days) stay on disk.

Size the PVC for 49 backup copies at the default retention of 48, plus the live database, its WAL and SHM files, and room for growth. The next temporary copy is written before pruning. For other retention values, budget for `BACKUP_KEEP + 1` copies.

To restore from a backup, stop the container, replace `/data/surf.db` with the chosen backup file, remove any old `/data/surf.db-wal` and `/data/surf.db-shm` files, and start the container again.

## Coexisting with `./start.sh`

The Vercel deployment with `./start.sh` and Cloudflare quick tunnels continues to work as before. To prevent a local `./start.sh` run from overwriting or clearing a fixed self-hosted server in discovery:

- Set `FIXED_SERVER_URL=https://surf.example.com` as a server-side Vercel environment variable and redeploy the web app. The discovery route always returns the configured URL and refuses dynamic publishes and clears, even when the fixed server is down. Add the browser-facing Vercel site origin to the fixed server's `ALLOWED_ORIGINS` so those browsers can connect.
- Set the same value in `apps/server/.env` for the local startup check. Both `./start.sh` and `pnpm host` check `/health` and refuse to start while the fixed server is healthy. If a host reaches the shutdown clear after discovery has changed, it sends `expectedUrl` and honors the route's `cleared: false` response.
