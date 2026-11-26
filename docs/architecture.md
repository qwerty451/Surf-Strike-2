# Architecture

The static client is on Vercel. The lobby runs as one Node process on the host's PC, exposed as `wss://` through a Cloudflare quick tunnel. The tunnel URL is published to the Vercel Runtime Cache every time the server starts.

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
| Game server | Host PC | Node 22+, `ws`, `better-sqlite3` | One lobby per map, relay, run validation, leaderboards |
| Tunnel | Host PC | `cloudflared` quick tunnel | Public HTTPS/WSS URL with no port forwarding |
| Database | Host PC | SQLite file | Accounts and sessions, guest players, personal bests, top-10 per map |

## Start-up flow (`pnpm host`)

Run `./start.sh` from the repo root to host for the public Vercel site. It loads Node 24 via `fnm`, checks `apps/server/.env` (`HOST_SECRET`, `DISCOVERY_URL`), `cloudflared`, installed deps and that the port is free, then `exec`s `pnpm host`. Flags: `--port <n>`, `--db <path>`, `-h`.

1. Start the game server on `localhost:27015`.
2. Spawn `cloudflared tunnel --url http://localhost:27015` and parse the `https://*.trycloudflare.com` URL from its output.
3. `POST` that URL to `https://<vercel-app>/api/server` with header `Authorization: Bearer <HOST_SECRET>`. The API keeps `{ url, startedAt, lastSeen }` in the Vercel Runtime Cache for 3 minutes.
4. Every 60 s, re-post as a heartbeat (`lastSeen`).
5. On shutdown (SIGINT/SIGTERM), post `{ url: null }` so clients skip the connection attempt.

## Client connect flow

1. Load the page and immediately start solo mode on the current default map.
2. `GET /api/server`. If `url` is null or `lastSeen` is older than 3 minutes, stay solo and show "Offline — solo" in the HUD.
3. Otherwise open `wss://<tunnel>/ws`. The `hello` names the map the client is on; the server puts it in that map's lobby ([Lobbies](#lobbies)).
4. On disconnect, fall back to solo on the same map. Retry discovery every 10 s.
5. A `?server=<url>` query parameter overrides discovery, for local testing.

## One-time setup

- Create a Vercel project. No storage is needed: the discovery record lives in the Runtime Cache (regional, not durable; every heartbeat writes it again). The Hobby plan includes 200,000 writes and 1 million reads a month for all projects together; a host that never stops writes 43,200 times a month. A Blob store (2,000 writes a month) was used before and got suspended.
- Set `HOST_SECRET` (random 32+ chars, enforced) in Vercel env vars and in `apps/server/.env`.
- The endpoint reads env via `process.env` because SvelteKit 3 deprecated `$env/dynamic/private`.
- `apps/server/.env` (see `.env.example`): `HOST_SECRET`, `DISCOVERY_URL`, `PORT` (27015), `DB_PATH` (default `apps/server/data/surf.db`), optional `CLOUDFLARED`, `ADMIN_USERNAMES` (admin accounts, default `tim`; [Admin and bans](#admin-and-bans)).
- Set `DISCOVERY_URL` in `apps/server/.env` to the deployed Vercel app.
- `cloudflared` is already installed at `~/.local/bin/cloudflared`.
- The host's Node is v20.20.1, which is past end of life (April 2026). Upgrade to Node 22 or 24 (via `fnm`) before development.

## Netcode

Each client simulates its own movement with zero input lag. The server trusts positions but validates timed runs, then relays everyone's state to everyone else.

- **Client to server:** a binary state packet at 64 Hz (one per 64-tick simulation tick): position, velocity, view angles, flags (ducked, on ground), tick number.
- **Server to clients:** a binary snapshot at 32 Hz with all players' states, plus JSON reliable events (chat, zone hits, run finished, lobby change, join/leave). Every message about players goes to their lobby only.
- **Remote players:** rendered `INTERP_DELAY_MS` (100 ms) in the past, interpolated between snapshots, which go out at `SNAPSHOT_HZ` (32); both constants live in `packages/shared/src/protocol.ts`, and the hide and seek and infected lag compensation read them.
- **Lag compensation (infected):** the server keeps `INF_HISTORY_MS` (400 ms) of poses per player (`packages/shared/src/modes/infected/lagcomp.ts`), with the view pitch, the motion of the body, the posture and the held item, cleared on every spawn and teleport. Live clients send `fire` with `tick: 2^31-1`; the server tests the shot or swing against the poses of `infRewindMs(ping)` = ping + 100 + 15.6 ms ago, interpolated between samples. A `fire` that names a sim tick (tools, tests) is clamped to the same window: no older than that rewind, rounded up to sim ticks, plus one tick (`clampFireTick`). Infected client messages are checked field by field in `apps/server/src/modes/infected-input.ts`; a malformed message is dropped whole. Rules: [modes.md](modes.md#infected).
- **Run validation:** the client sends zone events with tick numbers. The server checks:
  - zones were entered in order (start, stages in order, end);
  - elapsed ticks roughly match wall-clock time (±5%);
  - horizontal speed never exceeded `sv_maxvelocity`;
  - no position jumps larger than speed allows (teleport detection), except server-known teleport triggers.
  A run failing any check is not saved, and the player gets a chat notice.
- **Close codes:** 4000 no hello within 10 s, 4001 bad player id, 4002 same player id or same account connected again (old socket; that client stops auto-reconnecting until reload), 4003 server full, 4008 rate-limit kick, 4009 banned (sent after a `banned { reason, seconds? }` message; the client shows the ban screen and stops auto-reconnecting until reload, or with `seconds` until the ban lifts; see [Admin and bans](#admin-and-bans)), 4010 too many clients from this IP address ([connection limit](#connection-limit); the client stops auto-reconnecting until reload).
- **Security:** friends-only by design. Chat is HTML-escaped, names are limited to 24 chars, and each client is rate-limited (state 70 msg/s, chat 2 msg/s). No anti-cheat beyond run validation. Accounts: see below. Admin rights come only from the logged-in account (`ADMIN_USERNAMES`), never from a display name, and guests cannot use a registered username as their name ([Admin and bans](#admin-and-bans)).

## Protocol sketch

| Direction | Message | Encoding |
| --- | --- | --- |
| C→S | `hello { playerId, name, version, token?, map? }` (`token`: stored session, auto-login; `map`: the lobby to join, else the default map) | JSON |
| S→C | `welcome { selfId, map, mode, players[], cvars, records, account }` (`players`: that map's lobby) (`account`: `{ username, admin }` or `null` for guests; `admin` only decides whether the client shows the Admin menu) | JSON |
| S→C | `maps { enabled[] }`: maps players may join (server browser); right after `welcome` and to everyone on every change | JSON |
| S→C | `lobbies { counts }`: players per map lobby (`{ mapId: n }`, spectators included, empty lobbies left out); right after `welcome` and to everyone when a count changes, at most once a second | JSON |
| C→S | `register { username, password }`, `login { username, password }`, `logout {}` (any time after `welcome`, on the open socket) | JSON |
| S→C | `auth { ok: true, username, token?, records?, admin? }` / `auth { ok: false, error }` (`username: null` = logged out; also sent with `ok: false` after a `welcome` whose hello token was rejected) | JSON |
| C→S | `state` (tick, pos, vel, angles, flags) | binary, 64 Hz |
| S→C | `snapshot` (all players' state) | binary, 32 Hz |
| C→S | `zone { kind, index, tick }` | JSON |
| S→C | `runResult { ticks, rank, pb, record, splits, records }` (`records`: the runner's PB, rank and map record after the run, PB or not) | JSON |
| S→C | `ghostLook { map, loadout }`: what the record ghost's holder wears, with the ghost frame | JSON |
| S→C | `scoreboard { rows[], richest?[{ name, coins, online }] }` (1 Hz, every mode): `ScoreRow` per player, with the mode's fields and the account totals `pointsTotal` (lifetime earned, no longer shown), `playtimeSecs` and `coins` (what it has now); all are `null` for guests and absent on older servers (shown as `–`) | JSON |
| S→C | `records` inside `welcome`, `mapChange`, `runResult`, `auth` and `records`: `{ pbTicks, pbSplits, rank, recordTicks, recordName, top? }`; `top` = first 10 times `{ rank, name, ticks, self? }` on race maps, absent on older servers and in other modes | JSON |
| S→C | `records { map, records }`: pushed to every other player on the map when a run sets a new PB (their rank and the map record may have changed) | JSON |
| C↔S | `chat { text }` / `chat { from, text, admin? }` (`admin`: server-set marker for admin senders; scoreboard rows carry the same flag) | JSON |
| C→S | `admin { action }`: `setMapEnabled { mapId, enabled }`, `ban { targetId? \| username?, reason? }`, `unban { banId }`, `coins { username, op: add\|subtract\|reset, amount? }` (whole coins), `giveItem { targetId, item }`, `takeItem { targetId, item }`, `listBans`. Re-checked on the server; non-admins get `adminResult { ok: false }` and nothing happens | JSON |
| S→C | `adminResult { ok, error?, message? }` (every `admin` request) and, to admins only, `adminState { maps[{ id, title, kind, enabled }], bans[{ id, username, kind, reason, createdAt, createdBy, secondsLeft? }], abuse[]?, players[{ id, name, account?, guest, admin, coins? }] }` (after each request and when players or bans change) | JSON |
| S→C | `banned { reason, seconds? }`, then close 4009 | JSON |
| C→S | Shop: `shopBuy { item }`, `shopEquip { slot, item }` ([economy.md](economy.md#shop)) | JSON |
| S→C | Shop: `shop`, `shopResult`, `cosmetics { id, loadout }`; `loadout?` in `welcome.players[]` and `join.player` ([economy.md](economy.md#shop)) | JSON |
| C→S | Casino: `casinoBet { game, bet, … }`, `crashCashout` ([economy.md](economy.md#casino)) | JSON |
| S→C | Casino: `casino`, `crashStart`, `casinoResult`, `casinoNews` ([economy.md](economy.md#casino)) | JSON |
| S→C | Coins: `coins`, `award`, `multiplier`, `coinsNotice` ([economy.md](economy.md#wire)) | JSON |
| C→S | `changeMap { mapId }`: move to that map's lobby; answered with `mapChange`, or a system chat line (unknown, disabled, already there). `spectate { targetId }` (a player of the same lobby) | JSON |
| S→C | `mapChange { map, mode, cvars, records, players[] }`: to the player who moved; `players` are the new lobby's (the client replaces its remote players). The old lobby gets `leave`, the new one `join` |
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

## Lobbies

One server process, one lobby per map (`Room` in `apps/server/src/lobby.ts`), so every map of every mode can be played at any time, like one server per map. There is no rotation, vote or map timer.

- **What a room has.** Its map, its members, its `ServerMode` and its own `Economy` (activity, multiplier, round and session caps, abuse signals). The mode is created when the first player joins and disposed when the last one leaves, so an empty room costs nothing and starts fresh. The economy is kept, so caps and abuse strikes survive an empty room.
- **Scoped to the room:** snapshots, `join`/`leave`/`rename`/`spectating`, chat and the mode's system lines, `scoreboard` rows, `multiplier`, every mode message and binary frame. Spectating needs a target in the same room.
- **Server-wide:** connections and the player cap (`MAX_PLAYERS`, close 4003), accounts and sessions, playtime (`AccountStats`), bans and the admin menu, the shop, the casino and their news, the richest list, `maps` and `lobbies`. Coin changes that do not come from a map (shop, casino, admin, the register bonus) go through a separate `Economy` (the bank) that reaches every connection.
- **Joining.** `hello.map` picks the room; unknown, or disabled for a non-admin: the default map (`initialMap`; `pnpm host` uses `DEFAULT_MAP_ID`, `surf_aurora`), or the first enabled one. `changeMap { mapId }` moves a client: it leaves the old room (`leave` and "<name> went to Surf · Ember." there), joins the new one and gets `mapChange` with its players. Nobody else changes map.
- **`lobbies { counts }`** goes to everyone, at most once a second (`LOBBIES_MS`) and only when a count changed; also right after `welcome`. The client shows it in the server browser ([ui.md](ui.md#server-browser)). `/health` returns it as `lobbies`.
- **Chat commands.** `!map` lists the busy lobbies, `!map <name>` moves to the best match (exact id or title first, then a substring). `!rtv` explains that there are no votes.
- **Dev launcher** (`pnpm play`): the bots join the launch map's lobby and the browser URL carries `&map=<id>`, so you land with them; `POST /map?id=` moves the bots to another lobby.

## Accounts

Username + password, no email or verification ([gameplay.md](gameplay.md#accounts-and-identity)). Everything lives in the game server's SQLite; traffic is TLS (`wss://` through the Cloudflare tunnel). Code: `apps/server/src/auth.ts`, rules shared with the client in `packages/shared/src/account.ts`.

- **Rules:** username 1–24 characters, no whitespace at all, printable characters only (no control, zero-width or bidi characters), stored NFC with its original casing and unique case-insensitively (`username_lower`). Password 5–128 characters, nothing else.
- **Hashing:** `node:crypto` scrypt (N = 16384, r = 8, p = 1, 32-byte key) with a random 16-byte salt per account, stored as `scrypt$N$r$p$salt$hash` (base64url); checked with `timingSafeEqual`. A login for an unknown username hashes against a dummy hash so both failures take the same time and return the same error ("Wrong username or password.").
- **Sessions:** a successful register or login returns a token (32 random bytes, base64url). The server stores only its SHA-256 hash in `sessions`, valid for 90 days. The client keeps the token in localStorage and sends it in `hello` to log in automatically. `logout` deletes the session row. Expired rows are deleted when looked up and pruned on each new login.
- **Rate limits** (sliding one-minute window): 5 failed logins per connection and 5 per username (across all connections), then "Too many attempts. Wait a minute and try again."; 3 register attempts per connection. One register/login at a time per connection.
- **One connection per account:** a login (message or hello token) closes any other connection of that account with 4002.
- **Never logged:** passwords and tokens. The log shows only `login #id account <id> <username>` or `login failed #id`.

| Table | Columns |
| --- | --- |
| `accounts` | `id`, `username`, `username_lower` (unique), `password_hash`, `created_at`, `last_login` |
| `sessions` | `token_hash` (SHA-256 hex), `account_id`, `created_at`, `expires_at` |
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

The public host (`pnpm host`, so `./start.sh`) accepts at most 3 connected clients per IP address (`maxPerIp`, close 4010), so one person cannot fill the lobby with bots to raise the [player multiplier](economy.md#player-multiplier). IPv6 is counted per /64. A reload, or the same account in another tab, replaces the old connection first and does not count twice. Clients with an unknown address (loopback, local dev) are never limited, and the dev server (`pnpm server`) has no limit.

## Admin and bans

A small admin menu (Esc menu › Admin, [ui.md](ui.md#admin)) for the host. Code: `apps/server/src/admin.ts`.

- **Who is admin.** Only logged-in accounts whose username (case-insensitive, `username_lower`) is listed in `ADMIN_USERNAMES` in `apps/server/.env` (comma-separated; unset = `tim`, empty = no admins). The server decides at hello-token login and at `login`/`register`, and resets it on `logout`. Display names never count: a guest can type any name, but guest names equal (ignoring case) to a registered username are refused (hello falls back to `Guest-xxxx`; `name` / `!name` get a system message). The client is told `account.admin` only to show the menu; every `admin` message is re-checked server-side and non-admins get an error.
- **Rate limit and audit.** 30 admin actions per minute per connection. Every action is printed to the server console (`admin <name> (account <id>) <action> <target>`) and stored in `admin_log`; passwords, tokens and IPs are never logged.
- **Maps.** Only admins can join the lobby of a disabled map (`map_settings`), by `changeMap` or `hello`; a hello for one lands on the default map (or the first enabled one). Players already in it stay. At least one map always stays enabled. `adminState.players[].map` says which lobby each player is in.
- **Bans.** Targets: a connected player (by lobby id) or an account by username (offline ban). An account ban stores the account id (plus the player key of a connected target): all of its connections are kicked (`banned`, close 4009), and hello-token auto-login and `login` are refused. A guest ban stores the player key and, when known, the client IP: hellos with that key or IP are refused unless the hello token logs in an admin account. Admin accounts cannot be banned (nor ban themselves). Unban deletes the row. Bans by the abuse detection ([economy.md](economy.md#abuse-and-collusion)) have `created_by = auto` and an `expires_at`: expired ones no longer count and are deleted later. An admin can still ban such an account permanently.
- **Client IP.** Tunnel connections arrive from cloudflared on loopback, so the IP is the `CF-Connecting-IP` header; it is only trusted on loopback connections. Direct connections use the socket address. A loopback address is never stored (it would ban everyone on the tunnel).

| Table | Columns |
| --- | --- |
| `map_settings` | `map_id` (primary key), `enabled` (0/1; missing row = enabled) |
| `bans` | `id`, `account_id` (nullable), `player_key` (nullable), `ip` (nullable), `username_snapshot`, `reason`, `created_at`, `created_by`, `expires_at` (null = permanent) |
| `admin_log` | `id`, `created_at`, `admin_account_id`, `admin_username`, `action` (`enable-map`, `disable-map`, `ban`, `unban`, `coins-add`, `coins-subtract`, `coins-reset`, `give-item`, `take-item`), `target`, `detail` |

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

`packages/shared` is used by both the client (simulation, rendering input) and the server (zone positions for validation, the map list for the lobbies).
