# UI

CS2-era layout and feel: dark translucent panels, thin borders, condensed type. All art is original. Fonts are open (for example Barlow Semi Condensed and Rajdhani, self-hosted with `@fontsource`). No Valve assets or logos.

The HUD is Svelte components layered over the Three.js canvas.

## HUD layout

| Position | Element |
| --- | --- |
| Bottom centre | Speed (horizontal u/s, large), timer and current stage below it |
| Bottom centre, above speed | Split popup on stage or checkpoint (`Stage 3 01:12.402 −0.213`) |
| Top centre | Map name and time left (`surf_ember · 07:42`) |
| Top right | Connection status (`Online · 12 / 32` or `Offline — solo`), FPS if `cl_showfps 1` |
| Bottom left | Chat (fades after 8 s; full history while typing) |
| Left middle | Vote panel (up to 9 options "Surf · Kessler" … "Extend 10 min" with key numbers and live vote counts, countdown bar) |
| Top centre, below map name | RTV request modal (see [RTV request](#rtv-request)) |
| Top centre, below all of that | [Loot box news](#box-news) |
| Top left | Award popups ([Award popups](#award-popups)), below the position readout |
| Right middle | Score panel: map records, PB and gap, or the current standing ([Score panel](#score-panel)) |
| Centre | Crosshair (configurable) |
| Below crosshair | Pressed keys (W A S D, jump, crouch) if `cl_showkeys 1` |
| Full screen (hold Tab) | Scoreboard (see [gameplay.md](gameplay.md#tab-scoreboard)) |
| Top centre, spectating | `Spectating <name>` bar with controls hint |

The speed number turns green while gaining speed and red while losing speed, as on surf servers.

## Score panel

Always on while playing (`ScorePanel.svelte`), driven by the gamemode's definition in `packages/shared/src/modes/score.ts` ([modes.md](modes.md#score-display)).

- **Surf, bhop:** "Map records" (top 6 of the 10 the server sends), your own row highlighted, then Personal best with your rank and Gap to record (red, or "Record holder" in green). An older server sends only the record: the list is then the record and your own time. Offline: "Offline: no map records" and your local PB. "Unofficial" badge when `sv_*` was changed.
- **Other modes:** the live standing of the current game, best first, with the round number. Tag: time not IT, `IT` marker. Zombie Run: kills, times turned, and the route progress and checkpoint below. Infected: score, kills, kill streak, `A` / `INF` markers. Hide and seek: role, finds, survived.
- Every mode ends with a **Coins** line: the [multiplier](economy.md#player-multiplier) and the active players (`×1.5 6 active`), or `Off 2/3 active` in red when the mode needs more players to pay. Not shown offline or on an older server.
- At most 8 players (6 records). Your own row is always there: further down it replaces the last row, with a dashed line above it and its real position.
- **Placement.** Vertically centred in the free strip on the right, below the connection status (and a full kill feed) and above the mode's health and weapon bars. `score-panel.ts` holds these areas and `fitPanel`, which decides how much fits: fewer rows in low windows, narrower without minor columns below 1000 px width, only your own row (and the race lines) below 820 px, hidden below 480 px or when there is no height left.
- Hidden while the Tab scoreboard is open, and with `cl_scorepanel 0` (Settings › HUD › "Show score panel").

Dev preview: `/?mockhud&novote&mode=<gamemode>&players=<n>&self=<position>`, `&old=1` for an older server, `&open=scoreboard` for the Tab scoreboard, `&coins=<n>` award popups (`0`: a guest), `&warn` a warning, `&ban=<seconds>` the ban screen.

## Award popups

`AwardPopups.svelte`, pure helpers in `game/coins.ts`. Every award shows its amount, reason and multiplier (`+4.5 coins  Found a hider  ×1.5`) at the top left for 4.5 s, newest at the bottom, at most 5 (2 while a map vote is open, so they stay above its panel). Notices (guest hint, abuse warning) use the same stack for 10 s. They take no input, play no sound, and their width keeps clear of the banners at the top centre in every mode.

<a id="box-news"></a>

## Loot box and casino news

`BoxNews.svelte`, pure queue in `game/box-news.ts`. When someone opens a [loot box](economy.md#loot-box), every player sees a card at the top centre once the opener has seen the result: picture, "Ana opened a loot box", item and rarity in its colour, and a small "New" or "Duplicate".

- Common is small and short (4 s), uncommon a bit larger (5 s), rare glows (6 s), epic is the biggest with a pulsing glow (8 s). Cards slide in and out; with reduced motion nothing moves.
- At most 3 at a time and only as many as fit between the HUD and the crosshair. The stack starts below everything marked `data-top-hud` (map name, spectator bar, round banners, RTV request). While others wait, cards stay shorter, further common ones are merged ("+2 more"), and what waited more than 10 s (rare, epic: 20 s) is dropped.
- It takes no input and stays visible above the Esc menu. It is hidden under the console and the ban screen. The opener does not get their own card while the loot box screen is open.
- The picture comes from the pictures the shop keeps. Otherwise `itemPicture` (`render/character/preview.ts`) draws that one item in idle time on a small offscreen WebGL context. Creating it costs a long frame, so that happens while joining a server (`warmItemPictures`), and it stays until the game ends. The card shows at once, the picture when it is ready; without WebGL there is only the text.
- **Casino wins** of 5× the bet and more use the same queue: multiplier, "Ana won big at Crash" and the payout. The card grows with the tier reached (5×, 10×, 20×, 50×, 100×; `CASINO_LOOK`: 50 to 120 px, 4 to 9 s), each in its own colour; from 20× it glows, from 50× it pulses. They are never merged. Everyone gets them, the winner too. Dev preview: `&casinonews` (`=<multiplier>`).
- Sound: the zone bell, the record bell for rare and epic and wins from 20×, 8 to 10 dB below the opener's own.
- `cl_boxnews 0` (Settings › HUD › "Show loot box and casino news") turns cards and sound off. The chat lines for rare and epic items and for wins from 20× stay.

Dev preview: `/?mockhud&novote&boxnews` (one of each rarity in turn, `=<rarity or item id>` only that, `=all` a flood).

## Ban screen

`BanScreen.svelte`. A banned player gets "You are banned", the reason and, for a ban that lifts by itself, the time left. "Play solo meanwhile" (or `Esc`) shrinks it to a line at the top left with the countdown. The client reconnects by itself one second after the ban is over, also after a reload. The screen frees the pointer and counts as an overlay for game binds.

## RTV request

A small CS2-style vote notice (like the kick or pause vote) at the top centre, under the map name, while an RTV request is open ([gameplay.md](gameplay.md#map-rotation-and-voting); `RtvRequest.svelte`):

- Header "Map vote request" and the seconds left; text "**<name>** wants to vote for a new map (Bhop · Meadow)" (the nominated map, if any).
- Two buttons **1 Yes** / **2 No** with live counts, your own answer highlighted (the initiator starts on Yes), a 20 s countdown bar, and "1 = Yes · 2 = No · 2/4 yes needed".
- Keys `1` / `2` answer while the request is open (they do not trigger their binds then; `3`+ keep theirs). With a free cursor (pointer not locked), the buttons can be clicked.
- Spectators see it with "Spectating: you cannot vote".
- When it closes it shows "Passed: map vote starting" (green) or "Declined" (red) for 2.5 s; a passed request is replaced by the vote panel at once.

Key routing (`apps/web/src/lib/game/vote.ts` `routeVoteKey`, ahead of binds): map vote open: `1`–`7` vote; else RTV request open: `1` yes, `2` no; else the key's bind runs (for example Zombie Run weapon slots).

<a id="zombies-hud"></a>

## Zombie Run HUD

Shown on Zombie Run maps (`ZombiesHud.svelte`, [modes.md](modes.md#zombies)): a round banner under the map name (countdown; Survivor/Zombie, round clock, zone, zombies alive, your kills / team kills; result summary), route progress bar and the gate line ("Gate 2/5: get half the survivors into the green area" or "Gate 2/5 opens in 23 s"), short flash banners (checkpoint, gate, turned), kill feed top right, health (5 pips; a bar as a zombie) and weapon / ammo / reload bar bottom right, a loadout list (keys 1-4) while it is open, hit markers (white, yellow for headshots, red for kills), a red vignette when hit, and the sniper scope overlay. Binds in Zombie Run: mouse1 fire, mouse2 scope, R reload, 1-4 weapon (map vote while one is open).

## Hide and seek HUD

Shown on hide and seek maps (`HnsHud.svelte`, [modes.md](modes.md#hide-and-seek)), in two parts:

- **Top** (under the map name): a role banner (blue HIDER / red SEEKER) with the phase text ("Hide! Seekers released in", "Find them", "Stay hidden", "Next round in"), the phase countdown (mm:ss while seeking, red at 30 s or less), hiders left and your finds as a seeker; the seeker names; the round summary while ended ("Hiders win! Survived: …" / "Seekers win!", top seeker); short flash banners ("You were found by Alice — you are now a seeker", "You found Bob!", "Bob is the last hider", "30 seconds left"); a "Frozen 3" line during the post-find freeze; the cash bag note ("Cash bag in 1:20", then its place, an arrow and the distance from where you are, then who took it). Waiting / offline: "Waiting for players — needs 2+".
- **Screen**: the blindfold for seekers during the hiding phase (opaque black over the game with "You are a seeker", "Blindfolded while the hiders hide" and a large countdown; chat, the banner and the scoreboard stay on top; the crosshair is hidden), and the kill feed top right ("Alice found Bob", your own finds outlined).

The cash bag itself (`render/cashbag.ts`) is a canvas sack with banknotes and coins that bobs and spins in a light shaft over a ground ring. It is depth tested: never seen through walls. Taking it throws a burst of coins.

Seekers hold a knife viewmodel (the Zombie Run knife, swing on Mouse1); hiders have none. Remote seekers are drawn red with a `SEEKER · name` tag. Name tags show only within 600 units and in line of sight, and never hiders' tags to a seeker. `!r` is refused during a round.

## Infected HUD

Shown on infected maps (`InfectedHud.svelte`, [modes.md](modes.md#infected)). Pure helpers are in `ui/infected-hud.ts`; what is derived from server events (score popups, hit direction, summary rows) is in `game/infected-hud-events.ts`.

- **Crosshair.** The gap widens to the edge of the hip cone (`InfectedView.spreadDeg`, degrees to pixels from `fov` and the window height), and the crosshair fades out as the sights come up. Every other mode draws the cvar gap only.
- **Ammo prompt** (left of the crosshair, just above its line), one at a time: `R Reload` (magazine at a fifth or less, reserve left), `Low ammo` (magazine plus reserve at 35% of a magazine or less), `No ammo` with the slots that still work (`1 Primary`, `2 Pistol`, `3 Knife`, one per line). Never while reloading, spectating, down, outside a round or on the infected team (Patient Zero included).
- **Score popups** (right of the crosshair): `+100 Kill`, `+100 Headshot`, `+150 Infection`, `+200 Thrown knife`, `+250 Bank shot`, `+25 Survived`, `+50 Beacon`, `+250 Specialist`, `+500 M.O.A.B.`, `+250 Round won`. At most three, 2.4 s each, stacked upwards from just above the crosshair line, the newest lowest.
- **Hit direction.** A red arc on a ring around the crosshair (radius 188 px × HUD scale) points to where a hit came from and turns with the view: 1.2 s, the killing blow 2.2 s, at most 4. The direction is `hurt.dx/dy`, else the knockback vector, else the `shot` event of the same flush. A thrown-knife or bank-shot infection shows a lethal arc from the `dx`, `dy` of the `infect` event. An arc that would come within 8 px of the round header stack is not drawn (only at small window heights with three or four header rows, for hits from the front).
- **Hit marker.** White ticks for a body hit, longer gold ticks for a headshot, a wide red cross for a kill, with a gold pip when the kill was a headshot.
- **Round summary.** With `end.stats`: a panel with the winner, round time, survivors left, the next loadout (`end.nextLoadout`) and one row per player (score, kills, infections, deaths, accuracy, best streak). The viewed player is highlighted, Patient Zero is tagged, and the team bar is cyan for survivors and red for infected. One table up to 8 players, two up to 16; above that the best 16 with the viewed player always among them, and "+N more players". The kill feed and the hit arcs are hidden while it shows. Without stats the one-line summary stays.
- **Scope.** The rifles' overlay fades in over the last part of the aim while the lens closes in; the vertical hair starts below the header stack.
- **Spectating.** Popups and the highlighted summary row are the target's; no popups in free-fly; no ammo prompt, hit arcs or hit marker.
- **Reduced motion** (`prefers-reduced-motion: reduce`): no animation runs in this HUD and every event cue eases in and out (hurt vignette, hit marker, hit arcs, score popups, flash, UAV line, perk toast, +20s and +AMMO). The M.O.A.B. detonation is a dim amber wash (peak opacity 0.3) that eases in and fades once. The hurt vignette is softer: it takes 150 ms to reach 0.4 and continues from its level on repeated hits. Recoil is not affected ([modes.md](modes.md#infected)).

Dev preview: `/?mockhud&mode=infected&scene=<scene>` with the scenes `survivor`, `reload`, `low`, `empty`, `emptypistol`, `scope`, `scopedry`, `alpha`, `infected`, `down`, `last`, `stack`, `moab`, `ended`, `ended2`, `ended16`, `ended32`, `spec`, `specended`, `practice` and `practicescope` (list: `INF_MOCK_SCENES` in `ui/infected-mock.ts`). `&vote=1` keeps the map vote open, `&keys=0` hides the keys display, `&scale=1` forces `--hud-scale`. The mock re-issues the scene about once a second and shows popups and timed labels mid-life.

## Infected practice range

While the practice range is open ([modes.md](modes.md#practice-range): waiting for players, or offline), the waiting banner reads "Practice range · a round needs 2+ players" and a line under it names the keys of the held weapon: LMB Fire (Swing for melee), RMB Aim (Scope for the two rifles; nothing for melee), R Reload (guns), 1 2 3 Weapons, 4 Next primary. No score, kill feed or round summary. Dev preview: `/?mockhud&mode=infected&scene=practice` and `scene=practicescope`.

## Remote players

Remote players are animated characters with cosmetics and a name tag ([characters.md](characters.md)). Up close the tag stays at most 160 px wide in a window 720 px high (`TAG_MAX_SHARE` in `render/players.ts`, in every mode); who sees a tag is up to the mode. In Infected and Zombie Run they hold their weapon ([modes.md](modes.md#infected)).

## Weapon model viewer

Dev only: `/?mockvm` draws the first-person weapon and claw models without the game or the HUD (`render/viewmodel-viewer.ts`).

- First person: `&weapon=<id>`, `&view=fp|side|right|front|top|iso|rear|bottom|left` (`fp` uses the game's viewmodel scene, camera and draw order; the others are orthographic), `&pose=rest|kick|draw|reload|bolt|fire|slash|throw|land|aim|parts` with `&t=0..1` for the phase of the pose (left out: its extreme). `reload` is an empty gun's, `&rounds=1` one with a round left; `bolt` is the sniper's after a shot; `fire` runs through the fire interval after a shot (at most 300 ms, `&aim=1` aimed, `&rounds=0` the last one). For `aim`, `t` is the linear aim progress, eased like the game, with the world zoomed over the last 180 ms of the aim as in the game; without `t` it is fully aimed, and the scoped rifles stop where the scope overlay starts. `&knife=0` hides the claws' off-hand knife, `&bg=sky|dark|light`, `&anim=1` loops the pose, `&gen=0` shows the code-built models. Contact sheets: `&sheet=weapons|poses|views|aim|parts`, and `&sheet=reload|bolt|fire` with twelve phases of one weapon. `&pose=parts&part=<name>&t=0..1` moves a part of the gun along its travel (`render/gun-rig.ts`; several with commas, none named: all), and `&hand=<pose>` shows the gloved hands in a named pose (`render/hand-poses.ts`: `grip`, `grip_off`, `fore`, `mag`, `bolt`, `cover`, `knife`, `open`, `fist`), with `&from=<pose>&blend=0..1` in between two and `&close=1` framing the hand.
- Third person (`&tp=1`): another player's character holding the weapon, as in the game. `&look=infected|alpha` (claws only; everything else is held by a survivor), `&view=front|side|iso|rear|left`, `&dist=near|close|300|500|800` (300 and up: that many units away, as big as on a 1080 px high screen), `&duck=1`, `&pitch=<deg>`, `&fire=1`, `&hits=1` (the server's hit capsules over the character), `&pose=reload&t=0..1` (reloading; without `t` the new magazine is on its way), `&pose=bolt&t=0..1` (the sniper's bolt after a shot). Sheets: `&sheet=weapons|looks|views|pair|lineup|reload` (`pair`: each held model next to its first-person model; `lineup`: every weapon in one game view at 300 units; `reload`: six phases of one weapon's reload).
- The first frame waits until the first-person model files have loaded or failed, and each first-person label says which model it shows. Fit data is in `render/weapon-assets.ts`, the build in `tools/models/`.

## Account panel

Replaces the first-visit name prompt ([gameplay.md](gameplay.md#accounts-and-identity)). A small centred panel in the same style (`AuthPanel.svelte`):

- Tabs **Login | Register**: username field (`autocomplete="username"`) and password field (`type="password"`, `current-password` for login, `new-password` for register), submit button ("Please wait…" while the server answers).
- Register validates inline with the same shared rules as the server: "Username cannot contain spaces.", "Password must be at least 5 characters.", and so on. Server errors ("Wrong username or password.", "That username is taken.", rate limits) show under the fields.
- **Play as guest** switches to a name field (max 24 chars, prefilled with the stored guest name) and a "Play" button. Guests' runs are not saved to the leaderboard.
- Offline or connecting: a notice ("Server offline — play as guest; log in when online.") and the submit button is disabled.
- `Esc` or × closes it. Closing it on the first visit counts as playing as guest under the current name.
- Shown on the first visit and when a stored session is rejected (unless the player chose guest). After that the page goes straight into the game. Clicking the canvas requests pointer lock. While it is open, game binds are ignored as for the other overlays.

## Developer console

Opened with `` ` `` or `~`. A CS-style panel in the top half of the screen: scrolling log, input line, command history (up/down), tab completion for commands and cvars.

| Command / cvar | Default | Effect |
| --- | --- | --- |
| `sensitivity` | 2.0 | Mouse sensitivity (Source-compatible) |
| `m_yaw`, `m_pitch` | 0.022 | Degrees per mouse count |
| `zoom_sensitivity_ratio` | 1 | Infected: mouse sensitivity while aimed or scoped = sensitivity × ratio × tan(aimed FOV / 2) / tan(`fov` / 2), FOVs horizontal at 4:3. At 1 a mouse move shifts the picture as far on screen as unaimed |
| `cl_aimtoggle` | 0 | Infected: `Mouse2` toggles aiming down sights instead of holding it |
| `fov` | 90 | Horizontal FOV at 4:3, scaled for widescreen as in CS (106.26° at 16:9) |
| `volume` | 0.5 | Master volume 0–1 |
| `cl_fullscreen` | 1 | Play in fullscreen, where `Ctrl+W` cannot close the tab (Chromium only, [Platform](#platform)) |
| `cl_showfps` | 0 | FPS counter |
| `cl_showpos` | 0 | Position, angles, velocity readout |
| `cl_showkeys` | 0 | Pressed-keys display |
| `cl_hideplayers` | 0 | Hide other players |
| `cl_scorepanel` | 1 | Show the score panel ([Score panel](#score-panel)) |
| `cl_boxnews` | 1 | Show what other players get from loot boxes and win in the casino ([Loot box and casino news](#box-news)) |
| `cl_ghost` | 1 | Show the race ghost on surf and bhop maps ([Ghost](#ghost)) |
| `cl_crosshairsize`, `cl_crosshairgap`, `cl_crosshairthickness`, `cl_crosshaircolor_r/g/b`, `cl_crosshairdot` | CS-like | Crosshair |
| `name <name>` | | Change guest name (logged-in players always show their username) |
| `bind <key> <command>`, `unbind <key>` | | Key bindings |
| `map <id>` | | Change map (solo only) |
| `connect <url>`, `disconnect` | | Manual server connection |
| `sv_*` | per map | Physics cvars (solo only; runs become unofficial) |
| `cvarlist`, `help`, `clear` | | Console helpers |

Settings are saved to localStorage on change.

## Esc menu

A CS2-style pause menu opened with `Esc` (pointer lock is released). The game stays visible behind a dark gradient; the HUD is hidden while it is open. Components live in `apps/web/src/lib/ui/menu/` (`EscMenu.svelte` and one component per submenu); pure helpers (map grouping, settings sections, cvar defaults) are in `menu.ts` with unit tests.

Main menu (left column): brand, current map and mode, then the entries **Resume**, **Change map**, **Settings**, **Shop**, **Inventory**, **Coins**, **Casino**, **Account** (and **Admin** for admin accounts, see below), and below them the account line ("Logged in as X" or "Guest · runs are not saved") and a key hint. A submenu opens in a panel beside the entries; clicking its entry again folds it.

Keyboard: `↑`/`↓` move between the main entries, `Tab` moves through the open submenu, `←`/`→` (and `Home`/`End`) switch tabs. `Esc` goes back one level (submenu to main menu), then resumes. In the map filter and the item search, `Esc` first clears the text. Focus is always visible.

- **Change map**: tabs **All** plus one per gamemode with maps, in `GAME_MODES` registry order and labels (Surf, Bhop, Tag, …), so new modes appear without UI changes. Opens on the current map's mode. Within a mode, maps sort by difficulty (easy first), then title, then size. Each row shows title, id, an easy/hard badge (Medium/Large for maps that come in sizes, `mapTag` in `menu.ts`), and marks the current map. A filter box matches title, id or size. Picking a map switches at once and resumes in solo or when you are alone on the server (`canChangeMap`). With others online every map stays clickable (button tooltip and tag "Request map vote"): picking one starts an RTV request nominating it and resumes, so the modal is visible. The notice above the list says so, or, when requests are not possible, why and for how long: "Map vote declined — try again in 45 s", "Map vote requests open in 12 s" (first 20 s of a map), "A map vote is in progress", "A map vote request is open", or "Spectators cannot request a map vote" (rows read-only then). The current map and admin-disabled maps ("Disabled by admin") cannot be nominated. State logic: `mapMenuState` / `mapRowPickable` in `menu.ts`.
- **Settings**: tabs
  - Mouse: sensitivity (slider + number), Scoped sensitivity (`zoom_sensitivity_ratio`), Toggle aim (`cl_aimtoggle`), `m_yaw`, `m_pitch`
  - Video: FOV, **Fullscreen (blocks Ctrl+W)** (`cl_fullscreen`; in browsers without the Keyboard Lock API a note instead), show FPS, show position
  - HUD: crosshair colour, size, gap, thickness, centre dot with a live 1:1 preview; show keys, show score panel (`cl_scorepanel`), show loot box news (`cl_boxnews`), show ghost (`cl_ghost`), hide players (`cl_hideplayers`)
  - Audio: master volume

  Each tab has **Reset … to defaults**, which sets that tab's cvars to the engine defaults (`CLIENT_CVARS`); it is disabled when they already are.
- <a id="shop"></a>**Shop** (`ShopMenu.svelte`; pure helpers in `game/shop.ts`; rules in [economy.md](economy.md#shop)): only what can be bought. The balance, category tabs, items with picture, name, rarity (in its colour) and price (red when you cannot afford it), and a turntable of your own character. Owned items are marked "Owned" and come last; loot-only items never appear.
  - **Loot boxes** on top of All: one card with the picture, the price and the rarities that can drop; it opens the loot box.
  - <a id="lootbox"></a>**Loot box** (`LootboxMenu.svelte`, over the shop): first the box, the real chances, everything inside and **Open · 80 coins** (guests, too few coins and "You already own everything" are explained). Then a reel of items runs past a marker with ticks, slows down for about 6 s and stops on the item the server rolled; Esc or **Skip** ends it early. The result shows the picture, rarity, "New!" or the coins given back, **Wear it** and **Open another**. The balance hides a refund until then. With reduced motion there is no spin. Sounds: CREDITS.md.
  - Clicking an item tries it on (one per slot, on top of what you wear); clicking it again or **Reset look** undoes that. Drag turns the character; it stands still with reduced motion.
  - **Buy · 30 coins**, then **Confirm** or **Cancel**. Too few coins: the button is disabled and "You are X coins short" is shown. Guests get a login button. Errors show below.
  - After a purchase: "… bought." with **Wear it** and **Go to inventory** (opens it on that item). Nothing is worn by itself.
  - Offline, or on a server without a shop: one line says so.
- <a id="inventory"></a>**Inventory** (`InventoryMenu.svelte`): every item you own, of any rarity, plus the default look per slot. Opening it on 100+ items stays fast.
  - Category tabs, rarity buttons (only rarities you have), a search box (name, category, rarity; `Esc` first clears it) and **Sort: Rarity / Name** (rarest first, default look last). The counts follow the other filters and leave out the default look.
  - Cards have the colour of their rarity; worn ones have a green frame and "Worn". The first click shows an item on the turntable, the second wears it; **Wear** and **Take off** are below the turntable. The list under them shows what you wear per slot, each with × to take it off.
  - Owning nothing: a line and a button to the shop. Guests: a line and a login button. Offline or without a shop on the server: one line.
- Shop and Inventory share `ItemBrowser.svelte` (turntable, details, toolbar, scrolling list), `ItemCard.svelte` and `item-pictures.svelte.ts`. Narrow panels put the preview on top, sticky, and the list below. The preview (`render/character/preview.ts`, through `GameApi.createPreview`) is a second small WebGL context of at most 45 fps with its own geometry. It exists only while the submenu is open. The item pictures are drawn with it, one per frame, only for cards on screen, and are kept while the page lives (not those of the default look). No sounds.
- <a id="coins"></a>**Coins** (`CoinsMenu.svelte`): coins (rounded down), the current multiplier and active players, and the latest 30 changes: awards, purchases, loot boxes, admin changes and casino bets won and lost. On the right the five richest players (`RichList.svelte`, shared with the Tab scoreboard). Guests get a login button.
- <a id="casino"></a>**Casino** (`menu/casino/`; pure helpers in `game/casino.ts`; rules and odds in [economy.md](economy.md#casino)): tabs Coinflip, Crash and Slots. The header shows the net result of this session and of all time, and the coins. `CasinoTable.svelte` frames every game: the game, the bet box (Min, ½, 2×, Max; `Enter` plays), the last 12 results and "How it works" with the true odds and payback.
  - The server has decided before anything moves: the animation only shows it, and balance, net and results stay hidden until it ends. Closing the menu early loses nothing.
  - **Coinflip** (`CoinflipGame.svelte`): pick a side (arrow keys), a 3D coin is tossed and lands on the result.
  - **Crash** (`CrashGame.svelte`): a rising curve with the multiplier; the main button becomes **Cash out · n**. Optional auto cash-out with its chance. A running round is picked up again when the menu is reopened or after a reconnect; one that ends while the menu is closed shows a notice. After a cash-out (also an automatic one) the curve climbs on to the real crash and shows how much more there was; the next bet cuts it short. The bet is settled at the cash-out, the rest is only shown. A click on Cash out just after the crash does not place a bet (1 s). A drum roll builds up with the multiplier (`crashBuild` in `audio/mix.ts`): a snare roll and, from 1.3×, timpani, louder, brighter and faster the higher it climbs; 9 dB softer after a cash-out; a cymbal at the crash.
  - **Slots** (`SlotsGame.svelte`, symbols in `SlotSymbol.svelte`): three reels stop one after another, the last one later when the first two match; the pay table is below.
  - With reduced motion there is no spin, toss, shake or count-up. Guests see the games and a login button; offline or on a server without a casino one line says so. Dev preview: `/?mockhud&novote&open=settings&view=casino` (`&tab=coinflip|crash|slots`, `&nocasino`, `&roll=<0..1>` a fixed roll).
- **Account**: "Logged in as X" with **Log out**, or guest with **Log in / Register** (opens the account panel).
- <a id="admin"></a>**Admin** (only when the server says the account is admin, [gameplay.md](gameplay.md#admin); `AdminMenu.svelte`): **Extend +10 min** in the header, then tabs
  - Maps: every map grouped by gamemode with an on/off switch (the last enabled map cannot be switched off) and **Force change** with an inline "Change now? Yes / Cancel"; the current map is marked.
  - Players: connected players with an Admin / Account / Guest badge and the coin balance of accounts, **Coins** (accounts; inline amount with Add, Subtract, and Reset with a confirm), **Item** (accounts; pick an item and Give, or Remove one they own) and **Ban** (inline confirm with an optional reason; not for admins), plus both for an account by username, also offline.
  - Bans: username, kind, reason, date, who banned, when it lifts, and **Unban**.
  - Abuse log: the latest 50 automatic warnings and bans with their evidence.

  The result of the last action shows under the tabs. In Change map, maps disabled by an admin are greyed with "Disabled by admin" and cannot be picked (admins still can).

All values are the same cvars as the console and are saved the same way.

Dev preview: `/?mockhud&open=settings` (main menu), `&open=maps` (map submenu), `&open=settings&view=settings&tab=hud` (a settings tab), `&view=account`, `&view=shop` (`&balance=<coins>`, `&boxall` a loot box with every rarity, `&coins=0` a guest, `&noshop`), `&view=inventory` (130 items, most of them made up; `&items=<n>`, 0 = empty), `&view=coins`, `&view=admin` (logged in as an admin; `&tab=maps|players|bans|abuse`), and `&solo=0` for the read-only map list. Infected HUD scenes: see [Infected HUD](#infected-hud); weapon models: see [Weapon model viewer](#weapon-model-viewer).

## Ghost

The race ghost ([gameplay.md](gameplay.md#ghosts)) is the player character ([characters.md](characters.md)) in a pale cyan, at opacity 0.35 (stronger at the silhouette) with a faint glow, drawn without depth writes so it never hides the map. Its name tag is a small drawn ghost icon (no emoji font needed) and `Name · 01:23.456`, or `Your PB · 01:23.456` for your local best. `cl_ghost 0` hides it; `cl_hideplayers` does not affect it. The console prints `Record ghost: Name time` when one loads.

## Default key binds

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Space`, mouse wheel | Jump |
| `Ctrl` | Crouch |
| `Y` | Chat |
| `Tab` | Scoreboard |
| `1`–`9` | Map vote (while open); `1` / `2` = yes / no on an RTV request; else their binds (Zombie Run weapons `1`–`4`; Infected `1` primary, `2` pistol, `3` knife, `4` call M.O.A.B., or next primary on the practice range) |
| `Mouse1` | Attack: fire, knife or claw swing |
| `Mouse2` | Zombie Run: sniper scope. Infected: aim down sights (held; toggled with `cl_aimtoggle 1`), or throw the knife as infected |
| `M` | Toggle spectate |
| `R` | Restart run (`!r`); Zombie Run / Infected reload |
| `E` | Infected: plant a respawn beacon (`beacon`) |
| `N` | Infected: call an earned M.O.A.B. (`moab`) |
| `` ` `` / `~` | Console |
| `Esc` | Esc menu |

Binds added after a player first saved their table (`E` → `beacon`, `N` → `moab`) are offered once: they are filled in when the key is free and the command is not bound elsewhere, and the offered list is stored in `surf.binds.offered` so a later `unbind` sticks. In a window, `Ctrl`+`N` stays with the browser, so `N` does nothing while crouching; in fullscreen with the keyboard lock it works ([Platform](#platform)).

## Audio

All sounds are real recordings released under CC0, sourced from Freesound and listed with their trims in [CREDITS.md](../CREDITS.md). Nothing is synthesised: code only selects, places, levels, filters and convolves the recordings. Files live in `apps/web/static/sfx/` (AAC `.m4a`, 48 kHz, mono events, about 1.65 MB in total) and are fetched after the first user gesture; the combat pools (`SFX_DEFERRED`, about 0.8 MB) are fetched after the core set. A file that fails to load only silences that sound.

| Sound | Trigger | Recording |
| --- | --- | --- |
| Footsteps | Walking on ground; rate by speed, capped at running cadence | Boots on concrete, pool of 6 |
| Jump | Leaving the ground | Boot push-off on rock, pool of 4 |
| Land | Hitting the ground; louder with fall speed (level only) | Boot landing on rock (same session as jump), pool of 4 |
| Wind | Continuous loop; gain and a low-pass (400 Hz to 9 kHz) rise with speed, no pitch change | Mountain wind with strong gusts, stereo |
| Ramp slide | Continuous loop while surfing; gain rises with speed | Snowboard sliding on snow |
| Zone | Entering start, stage, checkpoint, end; hide and seek cash bag appears; casino win | Antique clock bell, one strike |
| Record | New PB or map record; casino win of 10× or more | Large church bell, one strike |
| Crash roll | Crash, while a round climbs | Snare drum roll and orchestral timpani roll, loops |
| Crash end | Crash, at the crash | 16" studio crash cymbal |
| Vote | Vote opens; hide and seek seeker release | Two gavel knocks on a wooden desk |
| Click | New chat message (the only click voice); casino: bet, coin lands, reel stops | Computer mouse button |
| Knife swing | Hide and seek: your knife swing; another seeker's swing within 1024 units (−6 dB per doubling of distance beyond 128) | Bamboo stick whooshes, pool of 4 |
| Knife hit | Hide and seek: you found a hider, or you were found | Knife stabbing a foam block, pool of 4 |
| Gunshots | Infected and zombies: your shot; another player's within 6000 units | One pool per weapon: 9 mm pistol (4), small-calibre shots for the SMG (5), rifle at an indoor range for the LMG (4), rifle shots with echo for the sniper rifle (4), large-gun shots for the .50 cal rifle (4), shotgun blasts (4) |
| Handling | Infected: another player's reload (within 1200 units); your own move by move (gun taken up, magazine out, magazine in, bolt, slide or cover closed), the sniper's bolt, dry fire, draw, scope; zombies: reload | Magazine out and in (3, and cut apart 3 and 3), rifle bolt closing (4), revolver dry fire (3), rifle handling (4 and 3) |
| Casings | Infected and zombies: a case or a shotgun shell lands, within 1200 units; 10 LU under the footsteps | Fired cases on a tiled floor (5), used shotgun shells on a hard floor (4) |
| Knife | Infected: knife and claw swings (the hide and seek swing pool), throw, bounce, stick, pickup; within 1200 units | Stick whooshes (4), knife dropped on a floor (4), knife into wood (4), blade rings (4) |
| Impact | A bullet hits the world, within 1200 units | Sticks hitting dirt (5) |
| Hit confirm | Your shot hit: body, head, kill (only the shooter hears it) | Boxing-mitt punches (5), hammer on a crowbar (4), desk bell (3) |
| Hurt, death, infect | You are hit; a body falls; a survivor turns (death and infect within 2400 units) | Punches (4), falls on a wooden floor (3), voiced growls (3) |
| Beacon | Infected: plant, smash, respawn; within 2400 units | Hammer on a stake (3), plastic smashed (3), electric sparks (3) |
| M.O.A.B. | Call; detonation; heard by everyone at one level | Air raid siren winding up; dynamite blast with mountain echo |

Rules:

- **One space.** Every event and the slide bed also feed one shared ConvolverNode with a measured impulse response (Liverpool Philharmonic Hall), with the send 14 dB below the dry signal. The wind is already an outdoor recording and stays dry.
- **Variation.** Pooled takes play in order (1, 2, …, n, 1, …) with a random ±1.5 dB level change per play. No playback-rate or pitch variation; only the Crash drum rolls play faster as the multiplier climbs.
- **Levels.** Takes in a pool are matched in loudness offline. The wind bed at full speed is the reference (−20 LUFS before the master volume). Events are placed relative to it in `apps/web/src/lib/audio/mix.ts`. Every file has a true peak of −1.5 dBTP or lower. The master volume (`volume` cvar) feeds a safety limiter.
- **Combat position.** Combat sounds (infected and zombies, `apps/web/src/lib/audio/combat.ts`) are heard from the camera. Your own play at their mix level, centred. Another player's fall off by 6 dB per doubling of distance beyond the near distance (128, 256 or 384 units), fade out over the last quarter of their range, and are panned by the angle between your view and the source (at most 0.8). While spectating, the listener is the spectator camera, and the spectated player's own sounds play centred at full level (`game/infected-listener.ts`).
- **Combat voices.** Combat sounds share 24 voices (`COMBAT_VOICES`). Each sound has 1 to 4 voices for your own plays and as many again for other players'. A new sound takes the oldest voice of the same sound when all of its voices sound, else a free voice, else the oldest voice of the same or a lower priority, and the old voice fades out over 3 ms. Combat levels leave the limiter untouched at the default volume.
- **Loops.** Loop points are prepared offline with an equal-power crossfade, so the loops are seamless.
- **Pipeline.** `tools/audio/process.py` rebuilds the files from the downloaded originals using `tools/audio/manifest.json`. `tools/audio/demo.py` renders a demo mix mastered to −14 LUFS for listening checks. `process.py --only <groups>` adds or redoes pools and leaves every other shipped file byte-identical. Both scripts use Python 3 and ffmpeg.

## Platform

Desktop browsers (Chrome, Firefox, Edge, Safari) with mouse and keyboard. Pointer lock is required. On touch-only devices, show a "Desktop only" message.

### Accidental Ctrl+W

Crouch on `Ctrl` plus forward on `W` is an easy slip that closes the tab. Pure rules are in `apps/web/src/lib/input/guard.ts` (unit tests in `guard.test.ts`).

1. **Block (Chromium, `fullscreen.ts`).** With `cl_fullscreen 1` (default) the click that locks the pointer also puts the page in fullscreen and calls `navigator.keyboard.lock()` for `Escape`, `W`, `T`, `N` and `Q`. `Ctrl` combinations then reach the page and are swallowed while the pointer is locked (`isBrowserShortcut`; developer tools, AltGr and Cmd combinations are left alone). F11 fullscreen does not count, and fullscreen without the keyboard lock does not block `Ctrl+W`.
   - Short `Esc` releases the pointer and opens the menu, still in fullscreen; hold `Esc` (about 1.5 s) to leave fullscreen. `Ctrl+W` does nothing in the menu either while fullscreen is on.
   - Leaving fullscreen releases the keyboard lock. The next click that locks the pointer enters fullscreen again. Resuming with `Esc` is not a user gesture, so it stays windowed. Switching the setting off leaves fullscreen at once.
   - One-time prompts outside our control: some Chromium versions ask "Override some keys on your keyboard" (if refused, a chat notice says that `Ctrl+W` is not blocked), and GNOME on Wayland asks "Allow inhibiting shortcuts" (either answer is fine). Both take the pointer lock, so the Esc menu opens: answer, then Resume.
   - A chat hint explains this once per browser, after the first successful lock.
   - Firefox and Safari have no keyboard lock: the setting is replaced by a note and the game stays windowed.
2. **Ask.** Otherwise a `beforeunload` "Leave site?" prompt is armed while the pointer is locked, for 2 s after it is released, and, with no menu or other overlay open, for 10 s after the last game key or resume (`leaveGuardArmed`; "Click to play" with keys still moving the player). Closing the tab from the Esc menu after 2 s asks nothing.
3. **Recover.** Session, guest name, player id, settings and binds are saved on change, so a reopened page reconnects at once under the same name; the server sends its current map. The last map (`surf.lastMap`) is loaded first (after `?map=`), so solo play returns to it. A run in progress is lost.
