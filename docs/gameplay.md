# Gameplay

This page covers the race modes (surf, bhop). Tag, infected, Zombie Run and hide and seek have their own rules: see [modes.md](modes.md#tag), [modes.md](modes.md#infected), [modes.md](modes.md#zombies) and [modes.md](modes.md#hide-and-seek). Chat, spectating, map rotation, solo mode and the lobby apply to every mode.

## Runs and timer

- The timer starts when the player leaves the start zone and stops when they enter the end zone.
- Leaving the start zone caps horizontal speed at 290 u/s (prespeed cap), so runs cannot start with stored speed.
- Ticks are counted, not wall time: time = ticks / 64 (CS2 tick rate), shown as `mm:ss.mmm`.
- `!r` or `!restart` teleports to the start zone and resets the timer.
- After finishing, the player is teleported back to the start automatically after 3 s (`FINISH_RESET_DELAY`), like `!r`. A manual `!r` or re-entering the start zone during the delay cancels it.
- Falling into a teleport trigger sends the player to the start of the current stage (staged maps) or the last checkpoint (bhop maps), and the timer keeps running. On the linear surf map it sends the player to the start and resets the timer (see below).

## Stages and checkpoints

- **Staged surf map:** each stage has a start zone. Entering it records a split. On fail, teleport to that stage's start.
- **Linear surf map:** checkpoint zones record splits only. On fail, teleport to the map start and reset the timer. (Checkpoint respawns are small ledges above each gap; they are only used by `!back`.)
- **Bhop maps:** checkpoint zones every section. On fail, teleport to the last checkpoint; the timer keeps running.
- `!back` teleports to the current stage or checkpoint start.
- Splits are compared to the player's PB splits and shown as `+0.412` (red) or `-0.213` (green).

## Personal bests and leaderboard

- The server saves a run when it passes validation (see [architecture.md](architecture.md#netcode)) **and the player is logged in**. Guests can play everything, but their finished runs only get "Finished in 01:02.345 (guest run, not saved)." plus, once per connection, "Log in to save runs to the leaderboard."
- Stored per account per map: best time, splits, date. `!top`, `!pb`, the scoreboard rank/PB and the map record all use accounts and show usernames.
- `!top` prints the top-10 for the current map in chat. `!pb` prints your own PB and rank.
- A new map record is announced in chat to everyone.
- The score panel (right side of the HUD: map records, your PB and the gap to the record, [ui.md](ui.md#score-panel)) is updated on join, map change, login/logout, after each of your own runs (PB or not), and whenever another player's new PB changes the leaderboard (new map record or a changed rank).
- Solo runs (offline) are shown locally but never saved to the leaderboard.

SQLite tables (accounts and sessions: [architecture.md](architecture.md#accounts)):

| Table | Columns |
| --- | --- |
| `account_runs` | `id`, `account_id`, `map`, `time_ticks`, `splits_json`, `created_at` (unique per account and map) |
| `players` | `id` (localStorage UUID), `name`, `first_seen`, `last_seen` (guest bookkeeping only) |
| `runs` | Legacy, read-only: guest runs from before accounts, keyed by the localStorage UUID |
| `account_stats` | `account_id` (primary key), `playtime_secs`, `points_total`, `points_balance`, `active_ms` ([Points and playtime](#points-and-playtime)) |
| `replays` | `map` (primary key), `account_id`, `time_ticks`, `samples`, `data` (BLOB), `created_at`: the map's record ghost ([Ghosts](#ghosts)) |

Only each account's best run per map is kept; a slower run is discarded.

Migration: tables are created with `CREATE TABLE IF NOT EXISTS`, so an existing database upgrades in place on start-up. The old `runs` table is left untouched but is no longer read or written: those runs were keyed by a guest UUID that anyone could reuse, and were timed at the old 128 tick, so they are not shown on any leaderboard.

## Points and playtime

Two totals per account, shown to everyone in the Tab scoreboard of every mode. Guests have no account and offline play has no server, so both show `–` there.

- **Total playtime** is the time connected to the server while logged in, in any mode, spectating and idling included, added up across sessions (`12h 34m`). An account connected twice counts once. The server writes it every 60 s, on disconnect or logout and at shutdown, so a crash loses at most a minute.
- **Coins** (`points_balance`) is what the account has now: it rises with earnings and winnings and falls with purchases and bets ([economy.md](economy.md)). The lifetime sum of earned points is stored too, but no longer shown.

## Ghosts

On surf and bhop maps (race modes only, never tag), a see-through ghost of the fastest run, in the colours and items of its player, races you, as in racing games, so you can watch and copy its line.

- **Which ghost.** Online: the map's record ghost, labelled with the holder's name and time (`Alice · 01:23.456`). With no record ghost yet, or offline, your own best run in this browser (`Your PB · 01:23.456`).
- **Playback** (client only). The ghost starts when your run starts (you leave the start zone) and plays in sync with your timer: at run tick *t* it is where the ghost was at its run tick *t*, interpolated between ticks for rendering. It is hidden while you stand in the start zone, and `!r`, `!restart`, teleports to the start and finishing hide it until your next run starts. It disappears once it has finished. It is purely visual: no collision, no sound. Hidden while spectating.
- **Recording (server).** The game server records every run from the state packets it already validates (64 Hz: tick, position, view angles, flags incl. ducked), from the `zone { start }` tick to the `zone { end }` tick. Only `Running`/`Finished` states are recorded, so the start-zone wait and the finish delay are not. When a logged-in player's run passes validation and is faster than the map's stored ghost, its replay is stored in `replays` (one row per map) and pushed to everyone on the map. Guest runs never become ghosts. The stored ghost is the fastest validated run recorded since ghosts were added, so on maps with an older record it can be slower than the record until someone beats it.
- **Recording (client).** The client records its own runs the same way from its simulation ticks, and keeps the fastest per map in IndexedDB (`surf-ghosts`, in memory if IndexedDB is blocked). Runs with changed physics cvars (unofficial) are not kept.
- **Encoding** (`packages/shared/src/ghost.ts`). Per sample: run tick delta, position in 1/8 units (int32; first value, first delta, then second differences), pitch and yaw as uint16 deltas, flags as uint8; columns stored one after another as varints, then `deflate-raw`. A one-minute run (3841 samples) packs to about 30 KB and deflates to about 11 KB. Runs longer than 30 minutes get no ghost.
- **Delivery.** On `welcome` and `mapChange` on a race map the client sends `getGhost { map }`; the server answers with a `BIN_GHOST` frame (the ghost, or "none") ([architecture.md](architecture.md#protocol-sketch)). The client inflates it with `DecompressionStream('deflate-raw')` (Chrome 103+, Firefox 113+, Safari 16.4+); without it the record ghost is skipped and the local PB ghost is used.
- **Settings.** `cl_ghost 0` hides the ghost (console, or Settings › HUD › "Show ghost" in the Esc menu). See [ui.md](ui.md#ghost).

## Chat

- `Y` opens chat, `Enter` sends, `Esc` cancels. Max 128 chars.
- Messages starting with `!` are commands and are not broadcast.
- System messages (joins, records, votes) in a distinct colour.

Chat commands:

| Command | Effect |
| --- | --- |
| `!r`, `!restart` | Back to start, reset timer |
| `!back` | Back to current stage or checkpoint |
| `!rtv` | Request a map vote (RTV request); on an open request: vote yes |
| `!top` | Top-10 for this map |
| `!pb` | Your PB and rank |
| `!spec [name]` | Spectate (a player, or the next one) |
| `!name <new name>` | Change name (guests only; logged-in players always use their username) |
| `!help` | List commands |

## Tab scoreboard

Hold `Tab`. Every mode shows its own columns ([modes.md](modes.md#score-display)) and then **Coins** and **Total playtime** ([Points and playtime](#points-and-playtime)). Your own row is highlighted. Header shows map name, mode, time left and player count (`12 / 32`). At the bottom of the screen: the five richest accounts of the server, online (green dot) or not, with their coins; your own is highlighted.

Race columns: name, map rank, PB, status (`Start zone`, `Stage 3`, `Running`, `Spectating`), ping. Sorted by PB, players without a PB last. On tag maps the columns are name (with an `IT` marker), time not IT, status (`IT`, `Runner`, `Spectating`) and ping, sorted by score. On hide and seek maps they are name, role (`Hider`, `Seeker`, `Spectating`), finds, survived (mm:ss as a hider this round) and ping, sorted by survived time, then finds.

## Spectating

- `!spec` or `M` enters spectator mode; `!spec` again or `M` returns to play (spawns at start).
- First-person view of the target, with their speed, timer and stage on the HUD.
- `Mouse1` / `Mouse2` cycle targets. `Space` toggles free-fly camera.
- Spectators have no timer and are counted separately on the scoreboard.

## Map rotation and voting

- Each map runs for 45:00.
- At 0:30 left, a 20-second vote opens for everyone.
- Options: up to 8 maps (`MAX_VOTE_MAPS`), picked at random from the enabled maps other than the current one: 2 surf and 1 each of bhop, tag, Zombie Run, Infected, Hide and seek and Zombie Defense (`VOTE_MAP_SLOTS`). A category with too few maps leaves free slots, filled with random maps of the other categories, so there are still 8 distinct maps (fewer only when fewer maps are enabled). They are listed by category in that order, each labelled with it ("Surf · Kessler", "Zombie Run · …"), in the panel and in the chat lines. The timed vote adds "Extend 10 min" as the last option (option 9 with 8 maps). Keys `1`–`8` (`MAP_VOTE_KEYS` in the web client's `vote.ts`) vote while the vote is open, instead of their binds (no weapon switch); changing a vote is allowed until it closes.
- Most votes wins. Ties are broken at random. No votes at all: a random map from the options.
- "Extend" adds 10:00 to the current map. At most 2 extends per map; after that, the option is not offered.
- **RTV request** (rock the vote): `!rtv` (or console `rtv`), or picking a map in Esc › Change map while others are online, asks everyone "<name> wants to vote for a new map (<map>)" in a modal at the top of the screen ([ui.md](ui.md#rtv-request)). It is open for 20 s. The initiator votes yes; every other non-spectating player presses `1` = yes or `2` = no (changing the answer is allowed). Spectators see it but cannot vote or start one.
  - It passes as soon as the yes votes reach a third of the non-spectating players, rounded up (1–3 players need 1, 4–6 need 2, 7–9 need 3, …; minimum 1). With 1–3 players the initiator's own yes is enough, so the vote opens at once. A passed request opens the map vote at once, without the extend option.
  - It is declined when the 20 s run out, or as soon as the remaining players cannot reach the threshold any more (enough no votes). Players who leave or start spectating lose their vote and the threshold is recomputed.
  - After a declined request nobody can start another for 60 s ("Map vote declined — try again in 45 s"). A passed request has no cooldown.
  - One request at a time; `!rtv` during an open request is a yes vote. No request in the first 20 s of a map, while a map vote is open, or during the change countdown. The scheduled 0:30 vote cancels an open request (no cooldown).
  - Nomination: a map picked from Change map is guaranteed a slot in the vote if the request passes (it replaces a random slot of its own category). The current map and admin-disabled maps cannot be nominated.
  - Chat gets short system lines (request started, passed or declined); the modal is the main UI.
- After a vote, a 5-second countdown, then everyone switches map. Running timers are cancelled.
- Alone in the lobby (the only connected client, spectators included), you can switch map at once from the Esc menu (Change map) or with console `map <name>`: the same change as a vote win (any vote is cancelled, the 45:00 timer and extends reset). With anyone else connected, the same pick (or `map <name>`) starts an RTV request nominating that map instead.
- Maps an admin disabled never come up in votes, `!rtv` or random picks, and normal players cannot pick them from Change map (shown greyed "Disabled by admin"). See [Admin](#admin).
- Maps are generated from code in the client bundle, so a map change has no download.

## Solo (offline) mode

- Same maps, timer, zones and splits as online.
- The 45-minute rotation and vote run locally; only you vote.
- Console `map <name>` or the Esc menu's Change map list changes map directly.
- HUD shows "Offline — solo". When the server comes online, the client connects and joins the server's current map.

## Accounts and identity

The leaderboard needs to know who set a time, so it only counts accounts. An account is a username and a password: no email, no verification.

- **Register:** username 1–24 characters with no spaces (printable characters only; unique, ignoring case; shown with the casing you chose), password at least 5 characters. Registering logs you in.
- **Log in:** same username (any casing) and password. Wrong details always give "Wrong username or password."; 5 failures in a minute lock that username and that connection for a minute.
- **First visit:** an account panel (Login | Register, plus "Play as guest") instead of the old name prompt. The game runs behind it.
- **Logged in:** your display name is your username; `!name` and the `name` cvar do not change it. The session lasts 90 days and logs in again automatically on reload or reconnect. "Log out" in the Esc menu (Account) ends it and you continue as a guest.
- **One place at a time:** logging in on a second tab or device disconnects the first (it falls back to solo and stops reconnecting until reloaded).
- **Guests:** pick a name (max 24 chars) and play everything, online and offline. A registered username (any casing) cannot be used as a guest name: online you play as `Guest-xxxx` until you log in. Runs are not saved; rename with `!name` or the `name` console command. A random player ID (UUID v4) and the guest name are stored in localStorage.
- **Offline:** logging in needs the server. The panel says "Server offline — play as guest; log in when online." and stays reachable from the Esc menu. A stored session is kept and used once the server is back.
- If a stored session expires, it is forgotten; the account panel opens again unless you had chosen to play as guest.

## Admin

Admin accounts (server config `ADMIN_USERNAMES`, default `tim`; [architecture.md](architecture.md#admin-and-bans)) get an **Admin** entry in the Esc menu ([ui.md](ui.md#admin)). Being admin depends only on the logged-in account, never on the display name; a guest named "Tim" is not an admin.

- **Maps:** enable or disable maps. Disabled maps leave the vote options, `!rtv` and the Change map list; the current map keeps running until it ends. At least one map stays enabled.
- **Force change:** switch everyone to any map at once (disabled ones too); **Extend +10 min** adds time to the current map.
- **Ban / unban:** ban a connected player (account, or guest by browser and IP) or an account by username. Banned players are disconnected with "You are banned" and cannot rejoin until unbanned. Point farming is banned automatically for 5 minutes ([economy.md](economy.md#abuse-and-collusion)). Admins cannot be banned.
- **Coins:** add to, subtract from or reset the coin balance of any account, online or offline ([economy.md](economy.md#admin-changes)).
- **Item:** give any cosmetic item to a connected account, or remove one it owns (also while worn; no refund).
- Admin names have an `ADMIN` marker in chat and on the scoreboard.

Lobby:

- Up to 32 players. Player 33 gets "Server full" and stays in solo mode.
- No player-to-player collision.
- Other players are original animated characters ([characters.md](characters.md)) with a per-player tint and a name tag. `cl_hideplayers 1` hides them.
