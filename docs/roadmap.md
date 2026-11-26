# Roadmap

Each milestone ends with something playable or testable.

Progress (2026-11-21): milestones 0–10 implemented with unit tests; 11 (production deploy, playtest) pending.

| # | Milestone | Done when |
| --- | --- | --- |
| 0 | Setup | Node 22+ via `fnm`; pnpm monorepo (`apps/web`, `apps/server`, `packages/shared`); SvelteKit + Three.js page renders an empty scene |
| 1 | Collision and physics core | Brush planes, AABB trace, grid broadphase, full `CGameMovement` port; all tests in [physics.md](physics.md#verification-tests-vitest) pass |
| 2 | Playable solo sandbox | Test map with flat ground, steps, a surf ramp pair and bhop blocks; mouse look, keys, fixed-tick loop with interpolation |
| 3 | HUD, console, settings | Speed/timer HUD, console with cvars and binds, Esc panel, name prompt, localStorage settings |
| 4 | Zones and timer | Start/end/stage/checkpoint/teleport zones, prespeed cap, splits, `!r`, `!back` (solo) |
| 5 | The four maps | `surf_aurora`, `surf_ember`, `bhop_meadow`, `bhop_circuit` with themes, procedural materials and zone outlines |
| 6 | Audio | All recorded CC0 sounds in [ui.md](ui.md#audio), credited in `CREDITS.md` |
| 7 | Server and netcode | Game server, protocol, remote-player interpolation, join/leave, 32-player cap, solo fallback and reconnect |
| 8 | Hosting | `pnpm host` launches server + `cloudflared` and registers the URL; `/api/server` on Vercel with the Runtime Cache and `HOST_SECRET` |
| 9 | Multiplayer features | Run validation, SQLite PBs and top-10, chat and commands, Tab scoreboard, spectate |
| 10 | Rotation and voting | 15-minute map timer, vote panel, extend, `!rtv`, map change countdown (online and solo). Replaced later by one lobby per map and a server browser ([gameplay.md](gameplay.md#lobbies)) |
| 11 | Deploy and polish | Vercel production deploy, playtest with friends, tune cvars and maps |

## Out of scope

- Practice mode (`!saveloc`, `!tele`)
- Weapons and viewmodels outside Zombie Run (which has a prototype set, [modes.md](modes.md#zombies))
- Anti-cheat beyond run validation
- Mobile and touch controls
- A map editor or loading Source `.bsp`/`.vmf` files
- Multiple lobbies or a server browser
- Valve assets, copies of existing maps, "Counter-Strike" branding
