# Architecture

Surf Strike 2 supports two deployment modes:

1. **Vercel + local host (`./start.sh`)**: the static client runs on Vercel, and the lobby runs as one Node process on a host PC behind a Cloudflare quick tunnel whose URL is published to the Vercel Runtime Cache.
2. **Self-hosted container ([hosting.md](hosting.md))**: a single Docker image (`node:24-trixie-slim`) bundles the Node 24 game server with the SvelteKit `@sveltejs/adapter-node` client on one port (`8080`). The client connects directly to `wss://<host>/ws` without `/api/server`.

```
 Friends' browsers                    Vercel                         Host PC
┌──────────────────┐   GET /       ┌──────────────────┐
│ SvelteKit client │──────────────▶│ static client    │
│ Three.js, physics│   GET         │                  │
│ HUD, console     │──/api/server─▶│ discovery API    │◀── POST /api/server ──┐
└────────┬─────────┘               │ (Runtime Cache)  │    (HOST_SECRET)      │
         │                         └──────────────────┘                       │
         │  wss://<random>.trycloudflare.com/ws          ┌─────────────────┐  │
         └──────────────────────────────────────────────▶│ cloudflared     │  │
                                                         └───────┬─────────┘  │
                                                                 ▼            │
                                                         ┌─────────────────┐  │
                                                         │ game server     │──┘
                                                         │ Node, ws, SQLite│
                                                         │ localhost:27015 │
                                                         └─────────────────┘
```

## Parts

| Part | Runs on | Tech | Job |
| --- | --- | --- | --- |
| Client | Vercel (static) | SvelteKit, Three.js, TypeScript | Rendering, movement simulation, HUD, console, solo fallback |
| Discovery API | Vercel function | SvelteKit `+server.ts`, Vercel Runtime Cache | `POST /api/server` stores the tunnel URL (needs `HOST_SECRET`); `GET` returns it |
| Game server | Host PC | Node 22+, `ws`, `better-sqlite3` | Lobby state, relay, run validation, map timer and vote, leaderboards |
| Tunnel | Host PC | `cloudflared` quick tunnel | Public HTTPS/WSS URL with no port forwarding |
| Database | Host PC | SQLite file | Accounts and sessions, guest players, personal bests, top-10 per map |

## Start-up flow (`pnpm host`)

Run `./start.sh` from the repo root to host for the public Vercel site. It loads Node 24 via `fnm`, checks `apps/server/.env` (`HOST_SECRET`, `DISCOVERY_URL`), `cloudflared`, installed deps and that the port is free, then `exec`s `pnpm host`. Flags: `--port <n>`, `--db <path>`, `-h`.

1. Start the game server on `localhost:27015`.
2. Spawn `cloudflared tunnel --url http://localhost:27015` and parse the `https://*.trycloudflare.com` URL from its output.
3. `POST` that URL to `https://<vercel-app>/api/server` with header `Authorization: Bearer <HOST_SECRET>`. The API keeps `{ url, startedAt, lastSeen }` in the Vercel Runtime Cache for 3 minutes.
4. Every 60 s, re-post as a heartbeat (`lastSeen`), refusing to overwrite a fixed non-`trycloudflare.com` server in discovery.
5. On shutdown (SIGINT/SIGTERM), reject new upgrades and return HTTP 503 on `/health`. Post `{ url: null, expectedUrl }` only if discovery still points to this tunnel, so a local host never clears a fixed self-hosted server. Then close the game server and stop the tunnel.

Before starting, `./start.sh` and `pnpm host` also check `FIXED_SERVER_URL` (if configured) and `GET /api/server`, refusing to run when a fixed self-hosted server answers healthy.

## Client connect flow

1. Load the page and immediately start solo mode on the current default map.
2. Check `?server=<url>`. If set, connect directly to that WebSocket URL.
3. In a self-hosted build (`SURF_ADAPTER=node`), connect directly to `wss://<host>/ws` (or `ws://` on HTTP) on the same origin without calling `/api/server`.
4. Otherwise (`adapter-vercel`), `GET /api/server`. If `url` is null or `lastSeen` is older than 3 minutes, stay solo and show "Offline — solo" in the HUD. If present, open `wss://<tunnel>/ws`.
5. Enter online mode after a `welcome` with the same protocol version. On a mismatch, show a reload notice and wait 60 s before trying again.
6. On disconnect, fall back to solo on the same map. The usual retry interval is 10 s.

## One-time setup

- Create a Vercel project. No storage is needed: the discovery record lives in the Runtime Cache (regional, not durable; every heartbeat writes it again). The Hobby plan includes 200,000 writes and 1 million reads a month for all projects together; a host that never stops writes 43,200 times a month. A Blob store (2,000 writes a month) was used before and got suspended.
- Set `HOST_SECRET` (random 32+ chars, enforced) in Vercel env vars and in `apps/server/.env`.
- The endpoint reads env via `process.env` because SvelteKit 3 deprecated `$env/dynamic/private`.
- `apps/server/.env` (see `.env.example`): `HOST_SECRET`, `DISCOVERY_URL`, `PORT` (27015), `DB_PATH` (default `apps/server/data/surf.db`), optional `CLOUDFLARED`, `ADMIN_USERNAMES` (admin accounts, unset by default; [Admin and bans](#admin-and-bans)).
- Set `DISCOVERY_URL` in `apps/server/.env` to the deployed Vercel app.
- `cloudflared` is already installed at `~/.local/bin/cloudflared`.
- The host's Node is v20.20.1, which is past end of life (April 2026). Upgrade to Node 22 or 24 (via `fnm`) before development.

## Netcode

Each client simulates its own movement at 64 Hz with zero input lag. The server trusts positions, validates timed race runs, and relays everyone's state to everyone else.

- **Wire protocol (`PROTOCOL_VERSION = 3`, `packages/shared/src/protocol.ts`):**
  - **Client to server (`BIN_STATE`, 47 or 55 B at 64 Hz):** float32 position, velocity and angles, tick, status, stage, run time, flags, an 8-bit teleport generation and a 16-bit spawn sequence. Combat clients append the last rendered server timestamp as a float64 once synchronized.
  - **Server to clients (`BIN_SNAPSHOT` v3, default 32 Hz).** The 13-byte header carries the frame kind, flags, player count, wrapping 16-bit sequence and float64 monotonic `serverTimeMs`. Each 31-byte player entry carries the sender tick, quantized pose, movement flags, teleport counter, status, idle flag and signed 24-bit sample time offset in 1/8 ms units. Race entries add 4 bytes for stage and run ticks. At 32 players the payload is 1,005 B for combat or 1,133 B for race, within the 1,150 B QUIC datagram budget.
  - **JSON reliable events:** chat, zone hits, run finished, votes, map change, join/leave, shop/casino, mode events, and clock pings.
- **Server time base and tick de-aliasing (`apps/web/src/lib/net/clock.ts`, `interp.ts`):**
  - The client seeds `ServerClock` from `welcome.serverTime`, pings the server every 1 s (`ping` → `pong { t, serverTime }`), and updates a 64-sample min-filtered offset (`localMs - serverTimeMs`) on every snapshot and pong. Downlink jitter spikes and TCP stalls cannot pull the clock backward; sustained route shifts slew smoothly and large clock shifts require four fresh pongs. The requested render timestamp never moves backward. Duplicate or out-of-order snapshot `seq` numbers are dropped.
  - The server assigns each remote pose a sample time using the sender's 64 Hz tick spacing around a sliding-median anchor. The browser's `SnapshotBuffer` and Zombie Run rewind use the timestamp carried by the snapshot. Within the offset's 17-minute range, repeated relays retain the pose's timestamp, so a late joiner and a client that missed a snapshot agree on the timestamps they share.
- **Adaptive interpolation, extrapolation, and teleport snap (`apps/web/src/lib/net/adaptive.ts`, `interp.ts`):**
  - `AdaptiveDelay` starts at two snapshot periods (62.5 ms at 32 Hz, 50 ms at 64 Hz) and stays within 50–200 ms. It tracks the peak snapshot age in each 500 ms bucket over six seconds. The second-highest bucket can raise the sustained delay up to 62.5 ms when the snapshot rate leaves room above the starting delay, with 16 ms of margin and 50 ms covered by extrapolation. Playback slows when a gap outlasts the expected arrival by 12 ms, up to a gap of 500 ms. After three consecutive late gaps within the extrapolation budget, playback allows the recurring gap before slowing. The delay rises by at most 450 ms/s and falls by up to 120 ms/s.
  - When a stall outruns the buffer, `SnapshotBuffer` predicts along the last velocity for up to 90 ms or 80 u of travel, whichever comes first. A sharp velocity change caps prediction at 25 ms. On hull contact the prediction can follow the contact plane for up to 24 ms. Race and Tag blend prediction corrections over 80 ms. Combat modes draw the corrected position immediately. A sender whose tick stalls holds the last confirmed pose.
  - Teleports snap on the first frame at or after the teleport sample time. A change of teleport generation, a new `FLAG_TELEPORTED` bit, or a jump over 1,024 u clears any correction in progress.
- **Combat rewind:** Infected, Hide and Seek, and Zombie Run send the server timestamp from the last rendered frame with attacks. Each remote player holds at its own prediction limit. Zombie Run's AI and the other avatars keep sampling the shared render clock. The rewind request uses the oldest active held pose when a hold occurs, bounded by the history and RTT budget at estimated receipt time. See [Render timestamps for lag compensation](#render-timestamps-for-lag-compensation).
- **Server loop and transport seam (`apps/server/src/scheduler.ts`, `transport.ts`, `apps/web/src/lib/net/transport.ts`):**
  - One drift-free absolute-deadline `TickScheduler` replaces the old `setInterval` timers (no 31.25 → 31 ms truncation drift), runs `tickMode()` immediately before `sendSnapshot()` on shared ticks, recovers from event-loop stalls without burst-sending, and drives slower tasks (rotation, scoreboard, pings, playtime flush). Setting `SNAPSHOT_HZ=64` in the server env enables 64 Hz snapshots (mode ticks stay at 32 Hz; `welcome.snapshotHz` tells clients the active rate). Default remains `32`.
  - Both `Lobby` (`ClientTransport`) and `NetClient` (`NetTransport`) sit behind small reliable/unreliable transport interfaces so a future datagram transport can plug in without changing framing or lobby logic. On WebSocket, droppable frames (`BIN_SNAPSHOT`, `BIN_ZOMBIES`) are skipped once `bufferedAmount` exceeds `max(2048 B, 3 × frameSize)` instead of queuing up to 1 MiB of stale state.
  - Record ghost compression (`apps/server/src/modes/race.ts`) skips non-record runs and runs `zlib.deflateRaw` (level 6) off the event loop on the libuv worker pool. Mode broadcasts with an excluded sender (`shot`, `reload`, `swing`) stringify the JSON payload once via `broadcast(msg, exceptId)`.
- **Diagnostics and benchmarking:**
  - Client console cvar `net_graph 0|1|2` (`apps/web/src/lib/net/stats.ts`, `NetGraph.svelte`) shows live RTT, jitter, adaptive interp delay, inbound snapshot Hz, underrun/extrapolation time, duplicate tick %, traffic rate, and (at level 2) a 120-snapshot inter-arrival sparkline.
  - `tools/net-bench.ts` runs the real server and headless 64 Hz bots through a deterministic userspace TCP-ordered delay/jitter/loss/burst proxy (`pnpm --filter server exec tsx ../../tools/net-bench.ts [--duration 5] [--hz 32|64]`).
- **Round-trip time.** The lobby sends a WebSocket control ping with a random challenge on join and every 500 ms. A challenge accepts one reply within two seconds. Combat uses the lowest RTT measured over the last five seconds, with a 50 ms fallback and a 150 ms cap. The scoreboard reports the uncapped estimate. The JSON ping remains available to clients and its echo does not affect combat timing.
- **Tag.** At 32 Hz the server checks for contact at the current poses and along the players' movement between checks. Contact requires horizontal proximity, overlap at each player's hull height, and a clear line through the overlap. The server skips sweeping after a teleport, an implausible displacement, or a state or rule check gap longer than 62.5 ms.
- **Combat teleports.** Every state carries the client's 8-bit teleport generation. The lobby accepts a discontinuity when a map trigger and landing are plausible or when the state acknowledges a server-issued spawn. It sends a separate validated generation to observers. A state that echoes the matching spawn sequence within 64 units of the spawn can also acknowledge it. The lobby resends the same spawn message every 250 ms while awaiting acknowledgement. Clients apply each spawn once and send `spawnAck { seq }` on every delivery of that sequence. A matching ack lets the first state start a fresh relay teleport generation even if the player has moved beyond the spawn radius.
- **Run validation:** the client sends zone events with tick numbers. The server checks:
  - zones were entered in order (start, stages in order, end);
  - elapsed ticks roughly match wall-clock time (±5%);
  - horizontal speed never exceeded `sv_maxvelocity`;
  - no position jumps larger than speed allows (teleport detection), except server-known teleport triggers.
  A run failing any check is not saved, and the player gets a chat notice.
- **Close codes:** 1001 server shutting down, 4001 bad player id, 4002 same player id or same account connected again (old socket; that client stops auto-reconnecting until reload), 4003 server full at hello, 4008 rate-limit kick, 4009 banned (sent after a `banned { reason, seconds? }` message; the client shows the ban screen and stops auto-reconnecting until reload, or with `seconds` until the ban lifts; see [Admin and bans](#admin-and-bans)), 4010 too many clients from this IP address ([connection limit](#connection-limit); the client stops auto-reconnecting until reload).
- **Hardening and metrics:** pre-hello sockets use a separate cap (`MAX_PENDING_CONNECTIONS`, default 16) so unauthenticated sockets cannot take up the 32 player slots. Optional `ALLOWED_ORIGINS` enforces a WebSocket `Origin` allow-list. `/health` stays lightweight for probes, and `/metrics` serves Prometheus gauges and counters (players, event-loop delay p50/p99/max, snapshot and mode tick lateness, bytes/s, max socket `bufferedAmount`, process RSS). See [hosting.md](hosting.md).
- **Security:** friends-only by design. Chat is HTML-escaped, names are limited to 24 chars, and each client is rate-limited (state 70 msg/s, chat 2 msg/s). No anti-cheat beyond run validation. Accounts: see below. Admin rights come only from the logged-in account (`ADMIN_USERNAMES`), never from a display name, and guests cannot use a registered username as their name ([Admin and bans](#admin-and-bans)).

### Render timestamps for lag compensation

The client sends `renderServerTimeMs` in combat states and with `fire`, `knife`, and `throwKnife`. The server estimates each connection's render offset from recent states and attacks. The estimate can change at the client's adaptive-delay slew rates with allowance for clock drift. Timestamp claims and legacy ticks use the same window around that estimate. The mode's history and the filtered RTT plus 200 ms of interpolation and 32 ms of slack apply a hard cap. An invalid timestamp uses the established estimate, or the current pose if the server has no estimate.

Infected uses rewind for gun and melee hits and the immediate segment of a thrown knife. The knife then flies on the live server simulation. Hide and Seek checks current and rewound poses. Zombie Run maps server time to the AI simulation tick and uses the same sender-tick sample timing as the renderer to rewind relayed player poses.

Protocol v3 carries one rewind timestamp per attack. When targets are drawn at different times, the oldest active hold can shift the server's hit test for another target.

## Protocol sketch

| Direction | Message | Encoding |
| --- | --- | --- |
| S→C | `serverIdentity { serverId }` immediately after the upgrade. Clients that negotiate `surf-server-identity` wait for this frame before sending hello. | JSON |
| C→S | `hello { playerId, name, version, token? }` (`token`: stored session, auto-login; `version = 3`) | JSON |
| S→C | `welcome { version, serverId, selfId, map, mode, mapTimeLeft, players[], cvars, records, account, serverTime?, snapshotHz? }` (`account`: `{ username, admin }` or `null` for guests; `serverTime` seeds client clock sync; `snapshotHz` reports the active snapshot rate) | JSON |
| C→S / S→C | `ping { t }` / `pong { t, serverTime }` (1 Hz client clock sync) | JSON |
| S→C | `maps { enabled[] }`: maps players may pick (votes, Change map); right after `welcome` and to everyone on every change | JSON |
| C→S | `register { username, password }`, `login { username, password }`, `logout {}` (any time after `welcome`, on the open socket) | JSON |
| S→C | `auth { ok: true, username, token?, records?, admin? }` / `auth { ok: false, error }` (`username: null` = logged out; also sent with `ok: false` after a `welcome` whose hello token was rejected) | JSON |
| C→S | `BIN_STATE` (type 1, 47 B base, with an optional 8 B combat render timestamp) | binary, 64 Hz |
| C→S | `spawnAck { seq }` (acknowledges a server spawn independently of the movement rate limit) | JSON |
| S→C | `BIN_SNAPSHOT` v3 (type 2: 13 B header with `seq` and `serverTimeMs`, then 31 B/player combat or 35 B/player race entries with sample time offsets, up to 1,133 B for 32 players, droppable under backlog) | binary, 32 Hz (or 64 Hz) |
| C→S | `zone { kind, index, tick }` | JSON |
| S→C | `runResult { ticks, rank, pb, record, splits, records }` (`records`: the runner's PB, rank and map record after the run, PB or not) | JSON |
| S→C | `ghostLook { map, loadout }`: what the record ghost's holder wears, with the ghost frame | JSON |
| S→C | `scoreboard { rows[], richest?[{ name, coins, online }] }` (1 Hz, every mode): `ScoreRow` per player, with the mode's fields and the account totals `pointsTotal` (lifetime earned, no longer shown), `playtimeSecs` and `coins` (what it has now); all are `null` for guests and absent on older servers (shown as `–`) | JSON |
| S→C | `records` inside `welcome`, `mapChange`, `runResult`, `auth` and `records`: `{ pbTicks, pbSplits, rank, recordTicks, recordName, top? }`; `top` = first 10 times `{ rank, name, ticks, self? }` on race maps, absent on older servers and in other modes | JSON |
| S→C | `records { map, records }`: pushed to every other player on the map when a run sets a new PB (their rank and the map record may have changed) | JSON |
| C↔S | `chat { text }` / `chat { from, text, admin? }` (`admin`: server-set marker for admin senders; scoreboard rows carry the same flag) | JSON |
| C→S | `admin { action }`: `setMapEnabled { mapId, enabled }`, `ban { targetId? \| username?, reason? }`, `unban { banId }`, `coins { username, op: add\|subtract\|reset, amount? }` (whole coins), `giveItem { targetId, item }`, `takeItem { targetId, item }`, `forceMap { mapId }`, `extend`, `listBans`. Re-checked on the server; non-admins get `adminResult { ok: false }` and nothing happens | JSON |
| S→C | `adminResult { ok, error?, message? }` (every `admin` request) and, to admins only, `adminState { maps[{ id, title, kind, enabled }], bans[{ id, username, kind, reason, createdAt, createdBy, secondsLeft? }], abuse[]?, players[{ id, name, account?, guest, admin, coins? }] }` (after each request and when players or bans change) | JSON |
| S→C | `banned { reason, seconds? }`, then close 4009 | JSON |
| C→S | Shop: `shopBuy { item }`, `shopEquip { slot, item }` ([economy.md](economy.md#shop)) | JSON |
| S→C | Shop: `shop`, `shopResult`, `cosmetics { id, loadout }`; `loadout?` in `welcome.players[]` and `join.player` ([economy.md](economy.md#shop)) | JSON |
| C→S | Casino: `casinoBet { game, bet, … }`, `crashCashout` ([economy.md](economy.md#casino)) | JSON |
| S→C | Casino: `casino`, `crashStart`, `casinoResult`, `casinoNews` ([economy.md](economy.md#casino)) | JSON |
| S→C | Coins: `coins`, `award`, `multiplier`, `coinsNotice` ([economy.md](economy.md#wire)) | JSON |
| C→S | `vote { option }` (1-based, up to 7), `rtv` (= `rtvRequest` without a map), `spectate { targetId }` | JSON |
| C→S | `rtvRequest { mapId? }`: start an RTV request, optionally nominating a map (on an open request: a yes vote); `rtvVote { yes }`: answer it. Errors come back as system chat | JSON |
| S→C | `voteStart { options, duration, rtv }` (up to 6 maps by category, then `extend`), `voteUpdate`, `voteEnd`, `mapChange { map, mode, ... }` | JSON |
| S→C | `rtvRequest { started, initiatorId, initiator, mapId, duration, yes, no, needed }` (start, every count or threshold change, and on join while open; `duration` = seconds left), `rtvRequestEnd { passed, reason: passed\|timeout\|rejected\|cancelled, cooldown }`, `rtvCooldown { seconds, reason: declined\|mapStart }` (on join and map change while requests are blocked) | JSON |
| S→C | `modeState { mode: 'tag', phase, round, timeLeft, it[], immune[], scores[] }` (non-race modes, on change + every 1 s), `tagged { by, target }` ([modes.md](modes.md)) | JSON |
| C→S | `getGhost { map }` (race maps, after `welcome`/`mapChange`) | JSON |
| C→S | Hide and seek: `knife { origin, dir }` (seeker swing; validated and lag-compensated against the hiders' position history, [modes.md](modes.md#hide-and-seek)) | JSON |
| S→C | Hide and seek: `modeState { mode: 'hns', phase, round, timeLeft, seekers[], hiders[], winner, players[{ id, role, finds, survived, frozen }] }` (on change + every 1 s), `hns { ev }` (`spawn` teleport+freeze to that player, `swing` to the others; `waiting`, `starting`, `roundStart`, `release`, `found`, `newSeeker`, `lastHider`, `warn`, `end` to everyone) | JSON |
| C→S | Zombie Run: `fire { weapon, origin, dir, tick }`, `reload {}`, `loadout { weapon }` (validated and lag-compensated by the server, [modes.md](modes.md#zombies)) | JSON |
| S→C | Zombie Run: `modeState { mode: 'zombies', phase, gates[], players[{ team, hp, ... }], ... }`, `zm { ev }` (spawn, hit, kill, shot, hurt, zhurt, down, checkpoint, gate, ammo, end) | JSON |
| C→S | Infected: `fire { weapon, origin, dir, tick }` (`tick: 2^31-1` = live client, rewound by its ping; a named tick is clamped to the same window), `reload {}`, `loadout { weapon }`, `throwKnife { origin, dir }`, `placeBeacon {}`, `callMoab {}` | JSON |
| S→C | Infected: `modeState { mode: 'infected', ... }`, `inf { ev }`. To one player: `spawn`, `ammo`, `hurt` (with `dx`, `dy`, the unit horizontal direction of the hit), `moabReady`; `hit` to the shooter; `shot` to everyone but the shooter (shotguns: `pellets`, flat `[dx, dy, dz, len, ...]` for pellets 2 to 8); `reload { id, weapon, ms }` to everyone but the reloader (`ms`: how long it takes them, halved by sleight of hand; 0: a swap ended it early); the rest to everyone, among them `infect` (thrown knife and bank shot: `dx`, `dy`), `kill`, `perk`, `moabCall`, `moabDetonate` and `end` (`stats[]`, `nextLoadout`). Weapon swaps are not relayed | JSON |
| S→C | `BIN_ZOMBIES` (type 4): `u8 4, u8 version, u32 sim tick, u8 count`, 11 bytes per zombie (id, position ·2 as i16, yaw, flags, hp); 32 Hz on Zombie Run maps, droppable under backlog | binary |
| S→C | `BIN_GHOST` (type 3): `u8 3, u8 version, u8 flags (bit 0 = has ghost), u8 mapLen, map, u8 nameLen, name, u32 ticks, u32 samples`, then the deflate-raw track. Reply to `getGhost` ("none" when there is no ghost or `map` is not the current map), and pushed to everyone on a new record ghost ([gameplay.md](gameplay.md#ghosts)) | binary |

## Accounts

Username + password, no email or verification ([gameplay.md](gameplay.md#accounts-and-identity)). Everything lives in the game server's SQLite; traffic is TLS (`wss://` through the Cloudflare tunnel). Code: `apps/server/src/auth.ts`, rules shared with the client in `packages/shared/src/account.ts`.

- **Rules:** username 1–24 characters, no whitespace at all, printable characters only (no control, zero-width or bidi characters), stored NFC with its original casing and unique case-insensitively (`username_lower`). Password 5–128 characters, nothing else.
- **Hashing:** `node:crypto` scrypt (N = 16384, r = 8, p = 1, 32-byte key) with a random 16-byte salt per account, stored as `scrypt$N$r$p$salt$hash` (base64url); checked with `timingSafeEqual`. A login for an unknown username hashes against a dummy hash so both failures take the same time and return the same error ("Wrong username or password.").
- **Sessions:** a successful register or login returns a token (32 random bytes, base64url). The server stores only its SHA-256 hash in `sessions`, valid for 90 days. The client stores the token in localStorage under the server's SQLite identity and sends it in `hello` after receiving the identity on that socket. Discovery can rotate a quick tunnel without changing the identity. Players with sessions saved before this change sign in once to save a session under the new key. `logout` deletes the session row. Expired rows are deleted when looked up and pruned on each new login.
- **Rate limits** (sliding one-minute window): 5 failed logins per connection and 5 per username (across all connections), then "Too many attempts. Wait a minute and try again."; 3 register attempts per connection. One register/login at a time per connection.
- **One connection per account:** a login (message or hello token) closes any other connection of that account with 4002.
- **Never logged:** passwords and tokens. The log shows only `login #id account <id> <username>` or `login failed #id`.

| Table | Columns |
| --- | --- |
| `accounts` | `id`, `username`, `username_lower` (unique), `password_hash`, `created_at`, `last_login` |
| `sessions` | `token_hash` (SHA-256 hex), `account_id`, `created_at`, `expires_at` |
| `server_settings` | `key` (primary key), `value`. The `serverId` row holds the UUID generated when the database is first opened by this version. |
| `replays` | `map` (primary key), `account_id`, `time_ticks`, `samples`, `data` (deflate-raw BLOB), `created_at`: one record ghost per map, replaced only by a faster validated account run ([gameplay.md](gameplay.md#ghosts)) |
| `owned_items` | `account_id`, `item_id` (primary key together), `bought_at`, `price` ([economy.md](economy.md#shop)) |
| `equipped` | `account_id`, `slot` (primary key together), `item_id`; references `owned_items` |
| `casino_log`, `casino_stats`, `casino_crash` | The newest 30 settled bets and the sums per account, open crash bets ([economy.md](economy.md#storage)) |

### Account totals

`apps/server/src/account-stats.ts` (`AccountStats`, owned by the lobby) counts the time online per account and serves the totals for the scoreboard ([gameplay.md](gameplay.md#points-and-playtime)).

- Connections join it at hello-token login, `login` and `register`, and leave it at `logout` and close. Connections are kept per account, so an account connected twice counts once.
- Whole seconds are added to `account_stats` in one transaction every 60 s (`PLAYTIME_FLUSH_MS`), when an account's last connection leaves, and in `Lobby.close()`. A failed write is logged and retried. The clock is `performance.now()` (monotonic).
- Points are paid by `economy.ts` ([economy.md](economy.md#implementation)). `points_total` (lifetime) and `points_balance` (spendable coins) are independent columns, both in tenths of a point ([economy.md](economy.md)); the wire field is whole points, rounded down.
- The table is created with `CREATE TABLE IF NOT EXISTS`; no existing table is changed, and an older server ignores it. A missing row means zeros.

| Table | Columns |
| --- | --- |
| `account_stats` | `account_id` (primary key, references `accounts`, deleted with it), `playtime_secs`, `points_total`, `points_balance` (integers, default 0) |

## Connection limit

The public host (`pnpm host`, `./start.sh`) and production self-hosted servers (`NODE_ENV=production`) default to 12 connected clients per IP address (`MAX_PER_IP`, close 4010) and 4 pending pre-hello sockets per IP (`MAX_PENDING_PER_IP`, HTTP 429). The global pre-hello cap returns HTTP 503. The server terminates sockets that do not complete hello on time. IPv6 is counted per /64. A reload, or the same account in another tab, replaces the old connection first and does not count twice. Unknown visitor IPs share one bucket for connection caps. The dev server (`pnpm server`) defaults to no per-IP cap.

## Admin and bans

A small admin menu (Esc menu › Admin, [ui.md](ui.md#admin)) for the host. Code: `apps/server/src/admin.ts`.

- **Who is admin.** Only logged-in accounts whose username (case-insensitive, `username_lower`) is listed in `ADMIN_USERNAMES` in `apps/server/.env` (comma-separated, unset or empty = no admins). The server decides at hello-token login and at password login, and resets it on `logout`. Public registration reserves configured admin usernames. Display names never count: a guest can type any name, but guest names equal (ignoring case) to a registered username are refused (hello falls back to `Guest-xxxx`; `name` / `!name` get a system message). The client is told `account.admin` only to show the menu; every `admin` message is re-checked server-side and non-admins get an error.
- **Rate limit and audit.** 30 admin actions per minute per connection. Every action is printed to the server console (`admin <name> (account <id>) <action> <target>`) and stored in `admin_log`; passwords, tokens and IPs are never logged.
- **Maps.** Disabled maps (`map_settings`) are left out of vote options, RTV nominations, random picks (`MapRotation` takes a live `isEnabled` filter) and the lone-player Change map; at least one map always stays enabled. Disabling the current map does not end it. `forceMap` changes to any map (disabled ones too) at once for everyone, through `MapRotation.forceMap` and the normal `mapChange` broadcast; `extend` adds 10 minutes (not during a vote or pending change).
- **Bans.** Targets: a connected player (by lobby id) or an account by username (offline ban). An account ban stores the account id (plus the player key of a connected target): all of its connections are kicked (`banned`, close 4009), and hello-token auto-login and `login` are refused. A guest ban stores the player key and, when known, the client IP: hellos with that key or IP are refused unless the hello token logs in an admin account. Admin accounts cannot be banned (nor ban themselves). Unban deletes the row. Bans by the abuse detection ([economy.md](economy.md#abuse-and-collusion)) have `created_by = auto` and an `expires_at`: expired ones no longer count and are deleted later. An admin can still ban such an account permanently.
- **Client IP.** Controlled by `TRUST_PROXY` ([hosting.md](hosting.md#trust_proxy)). Default `loopback` trusts `CF-Connecting-IP` and `X-Forwarded-For` only on loopback connections (local `cloudflared`). For Cloudflare-only trust, set `TRUST_PROXY=cf:<CIDRs>` with the IPs or CIDRs of the immediate cloudflared peers, such as `TRUST_PROXY=cf:10.42.0.0/16` for that pod range. Replace any bare `TRUST_PROXY=cf` before upgrading because it fails startup. For other reverse proxies, use explicit peer CIDRs or `TRUST_PROXY=private` on a trusted private network. Loopback and trusted proxy addresses are never stored.

| Table | Columns |
| --- | --- |
| `map_settings` | `map_id` (primary key), `enabled` (0/1; missing row = enabled) |
| `bans` | `id`, `account_id` (nullable), `player_key` (nullable), `ip` (nullable), `username_snapshot`, `reason`, `created_at`, `created_by`, `expires_at` (null = permanent) |
| `admin_log` | `id`, `created_at`, `admin_account_id`, `admin_username`, `action` (`enable-map`, `disable-map`, `force-map`, `extend`, `ban`, `unban`, `coins-add`, `coins-subtract`, `coins-reset`, `give-item`, `take-item`), `target`, `detail` |

## Repo layout

pnpm workspace monorepo:

```
apps/
  web/         SvelteKit client, adapter-vercel, /api/server route
  server/      Node game server (ws, better-sqlite3, cloudflared launcher)
packages/
  shared/      physics, collision, map definitions, protocol types, cvar defaults
docs/          these documents
```

`packages/shared` is used by both the client (simulation, rendering input) and the server (zone positions for validation, map list for votes).
