# Surf Strike 2 — Design Docs

Browser-based surf and bhop game with Source-engine movement. One shared lobby, no main menu (the page loads straight into a map), four original maps rotating by vote every 15 minutes.

Status: design agreed 2026-11-21. Milestones 0–10 implemented 2026-11-21; milestone 11 (deploy, playtest) pending.

Local dev instance: `./start_test.sh` (web client with hot reload on `:5173` + dev game server on `:27016` with its own `apps/server/data/dev.db`; `--web-port`, `--db`, `--fresh`, `--help`; Ctrl+C stops both). Run with Node 24 (`.node-version`, picked up by `fnm`): `pnpm install`, then `pnpm dev` (client), `pnpm server` (dev game server on `:27016`; dev builds connect there, production `./start.sh` uses `:27015`), `pnpm host` (server + tunnel + discovery; for the public Vercel site run `./start.sh` from the repo root, which preflights `.env`, `cloudflared`, deps and the port, then runs `pnpm host`; `--port`, `--db`, `--help`), `pnpm check`, `pnpm test`, `pnpm build`.

## Quick launch and testing scripts

`pnpm play` starts a dev game server (in-memory DB, never the real leaderboard), optional live bots, a local control API and the Vite client, then prints the URL to open (`http://localhost:5173/?server=ws://localhost:27016/ws`). Ctrl+C stops all of it. `pnpm play -- --help` lists every flag.

| Command | What it does |
| --- | --- |
| `pnpm play [mode\|map]` | Launch on a gamemode (its first map) or any map id, `sandbox` included; default `surf` |
| `pnpm play:surf` / `play:bhop` | Race modes, no bots |
| `pnpm play:tag` | `tag_quayside`, 1 bot, fast timers: a round starts as soon as you join |
| `pnpm play:zombies` | `zombies_lowtide`, fast countdown |
| `pnpm play:infected` | `infected_outpost`, 2 bots, fast timers |
| `pnpm play -- --list` | All gamemodes and maps |
| `pnpm test:mode <mode>` | Only the shared/server/web tests for one mode (`surf`, `bhop`, `tag`, `zombies`, `infected`); `all` = `pnpm check && pnpm test`; `--list` shows the files |

Useful flags: `--bots <N>`, `--bot-patrol` (bots walk a circle), `--fast`, `--grace/--round/--countdown <s>`, `--port`, `--web-port`, `--server-only`, `--open`, `--no-ctrl`, `--db <path>`.

Control API on `http://127.0.0.1:<port+1>` (default 27017) for scripts and agents:

| Request | Effect |
| --- | --- |
| `GET /status` (or `/health`) | `{ map, mode, port, webUrl, players, bots, modeState }` |
| `POST /map?id=<mapId>` | Force a map change |
| `POST /bots?count=<N>` | Scale live bots up or down |
| `POST /shutdown` | Stop the launcher (bots, game server, control API, Vite) |
| `POST /bot/move?index=0&x=&y=&z=&yaw=&pitch=` | Teleport a bot (omitted values stay) |
| `POST /bot/action?index=0&type=fire\|throwKnife\|placeBeacon\|reload\|loadout\|spectate` | Bot shoots or throws (aim with `tx,ty,tz` or `yaw,pitch`; `weapon=`), plants a respawn beacon (infected), reloads, picks a loadout, or spectates (`target=<id>`, `none`, or toggle). In infected a `fire` right after a `loadout` waits for the weapon's draw time; the reply carries `delayMs`, 0 when the shot left at once |

In solo mode (no server), `?map=<id>` opens that map directly, e.g. `http://localhost:5173/?map=infected_outpost`.

Dev previews (dev builds only): `?mockhud` shows the HUD and Esc menu with sample data (`&mode=infected&scene=<scene>` for the Infected HUD), and `?mockvm` shows the weapon models without the game ([ui.md](ui.md#infected-hud), [ui.md](ui.md#weapon-model-viewer)).

Weapon models: `tools/models/procedural/build.sh [id…]` rebuilds the script-built guns in `apps/web/static/models/weapons/` (Blender headless; one script per gun, guide in `tools/models/procedural/README.md`), and `tools/models/build.sh <raw dir> knife` the generated knife from its raw image-to-3D file (settings in `tools/models/manifest.json`). After a rebuild that changes the geometry, re-measure the fit points in `apps/web/src/lib/render/weapon-assets.ts`; `weapon-assets.test.ts` checks them against the shipped files.

## Documents

| File | Covers |
| --- | --- |
| [architecture.md](architecture.md) | Hosting, Cloudflare tunnel, server discovery, netcode, repo layout |
| [hosting.md](hosting.md) | Self-hosted Docker image, env vars, hardening, `/metrics`, SQLite backups |
| [physics.md](physics.md) | Source movement port, cvars, collision and traces |
| [gameplay.md](gameplay.md) | Timer, zones, stages, leaderboards, chat, spectate, map vote, lobby, accounts |
| [modes.md](modes.md) | Gamemode framework (surf, bhop, tag, infected, Zombie Run, hide and seek), how to add a mode, per-mode rules |
| [maps.md](maps.md) | Map format and the four map designs |
| [ui.md](ui.md) | HUD (Infected HUD included), console, cvars, Esc settings, account panel, audio, dev previews |
| [characters.md](characters.md) | Character models, animation, cosmetic slots and how to add an item |
| [economy.md](economy.md) | Points, coins, payouts per mode, abuse detection, and how a mode pays |
| [roadmap.md](roadmap.md) | Milestones and out of scope |
| [overview.html](overview.html) | Interactive visual overview of all the above (open in a browser) |

## Decisions at a glance

| Topic | Decision |
| --- | --- |
| Client | SvelteKit + Three.js + TypeScript, deployed on Vercel |
| Game server | Node + `ws` + SQLite, runs on the host's own PC |
| Public access | `cloudflared` quick tunnel, URL registered to a Vercel API backed by the Vercel Runtime Cache |
| Offline behaviour | Solo play with a local timer and rotation; auto-reconnects when the server comes up |
| Netcode | Client simulates its own movement; server validates runs and relays state |
| Physics | CS2 movement: 64 tick with subtick input on a Source `CGameMovement` port, SharpTimer CS2 surf/bhop cvars |
| Rendering/collision | Three.js; custom convex-brush AABB traces, no physics engine |
| Gamemodes | `MapDef.kind` is the gamemode: surf and bhop (race: timer, zones, PBs), tag (server-run rounds, score = time not IT) Zombie Run (co-op escape with weapons against AI zombies, gates, turned players fight for the zombies) and hide and seek (45 s blindfolded seekers, 4:00 knife hunt, found hiders become seekers, bhop capped at 300 u/s); rotation mixes all modes ([modes.md](modes.md)) |
| Features | Timer, zones, stages, PBs, top-10 leaderboard, chat, score panel, Tab scoreboard with total points and playtime, spectate |
| Not included | Practice `!saveloc`/`!tele`, weapons outside Zombie Run and infected (and the hide and seek knife), anti-cheat, mobile |
| Identity | Simple accounts (username + password, no email/verification) in the server's SQLite; only accounts' runs reach the leaderboard. Guests pick a name and play everything without saving runs |
| Settings | Developer console (`~`) plus an Esc menu (Change map, Settings, Account) |
| Admin | Esc › Admin for accounts in `ADMIN_USERNAMES` (unset by default; by account, never display name): enable/disable maps, force map change, ban/unban (account, guest key + IP, close 4009) |
| HUD | CS2-era layout and feel, original art, open fonts |
| Map vote | 15:00 per map; vote at 0:30 left; 3 other maps + "Extend 10 min"; `!rtv` at 60% |
| Maps | original: surf (aurora, ember, skyrend, hadal: all rated easy), bhop (meadow easy, circuit / reliquary / rimefall hard), tag (quayside), Zombie Run (lowtide); themed, stylised |
| Lobby | 32 players max, no player collision, animated low-poly characters with name tags ([characters.md](characters.md)) |
| Platform | Desktop browsers, mouse + keyboard, pointer lock |
| Audio | Real CC0 field/foley recordings (Freesound), one measured hall IR; no synthesised sound ([ui.md](ui.md#audio), [CREDITS.md](../CREDITS.md)) |

## Content rule

All maps, art and fonts are original. Sounds are real CC0 recordings, credited in [CREDITS.md](../CREDITS.md). No Valve assets, no one-to-one copies of existing community maps, no "Counter-Strike" branding. Movement matches Source because it is a port of the movement math, which is game mechanics, not content.
