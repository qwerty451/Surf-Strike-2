# Points and coins

Status: the core is implemented (ledger, activity, playtime points, abuse detection, client views, the API for modes), the awards of every mode, the [shop](#shop) and the [casino](#casino). The owner asked for a balanced point system and left the final numbers to us. Change the numbers here first, then in `packages/shared/src/economy.ts`, which holds all of them.

## Terms

- **Points** are what you earn. The lifetime sum never goes down; it is stored but not shown.
- **Coins** are the spendable balance. Every point earned adds 1 coin. Everyone sees everyone's coins on the Tab scoreboard. Buying in the shop lowers the coins only.
- Accounts only. Guests play everything but earn nothing.
- <a id="start-bonus"></a>**Start bonus.** A newly registered account starts with 100 coins (`START_COINS`): balance only, no lifetime points, written in the transaction that creates the account with one log row (`welcome`, "Welcome bonus", not counted towards the backstop). The player gets a notice. Accounts of before are unchanged.
- Repeating something never drops its award to nothing: the repeat decays end at 10 %, rounded up to whole points. Only missing conditions, caps per round, AFK, the backstop and the abuse rules pay nothing.
- All base awards are whole numbers, decided by the server. The multiplier makes fractions, so amounts are stored in tenths of a point (integers). Popups show one decimal when needed (`+1.2`); totals and the balance are shown rounded down.

## Target rates

A basic shop item costs 30 coins and a loot box 80. With the rates below that is about 15–20 minutes of normal play for a basic item (45 minutes of only being online) and about 40–50 minutes for a loot box (2 hours online).

| Play | Points per hour |
| --- | --- |
| Online and active, no mode awards | 40 |
| Average player in any mode, including playtime | 90–130 |
| Very good player in any mode, including playtime | 150–190 |

No mode should pay clearly more per hour than another at the same skill. Where a mode can be repeated quickly, the awards decay.

Estimates for the race modes, Zombie Run and Zombie Defense, playtime included:

| Mode | Average player | Very good player | From |
| --- | --- | --- | --- |
| Surf and bhop | 75–90 | 110–155 without changing the map early, up to about 190 with `!rtv` | Clean runs of 30–50 s (easy surf), 45 s (bhop), 55 s and 89 s (hard surf), 15-minute map sessions |
| Zombie Run | 105–145 | 155–175 | 16–18 rounds per hour, nearly all won; average 22–35 per hour, mostly lost at gate 2–4 (bots with human aim errors in the real rules) |
| Zombie Defense | 87–94 | 128–170 | Solo games lost at wave 6–10 / reaching wave 20–30, shortest possible waves (a model in `economy.test.ts`, not bots; [Zombie Defense](#zombie-defense)) |

Both ranges are at multiplier ×1.0. In the multiplayer modes a full lobby pays up to twice as much.

## Player multiplier

Owner's rule. In Zombie Run, Zombie Defense, Infected, Hide and seek and Tag every award, including the cash bag, is multiplied by the number of active players on the server when it is paid. It does not apply to surf, bhop or playtime.

| Active players | 1–2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 and up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Multiplier | ×1.0 | ×1.2 | ×1.3 | ×1.4 | ×1.5 | ×1.6 | ×1.7 | ×1.8 | ×1.9 | ×2.0 |

**Active player:** connected, not spectating, and has moved in the last 30 seconds. Anyone still for longer is AFK: not kicked, only not counted. Time in which the game itself holds a player still (frozen or blindfolded seeker, respawn wait, map change) does not run the 30 seconds down. Players in a Hide and seek round also stay active by looking around: hiders sit still, and a seeker may guard the cash bag. An account connected more than once counts once. Guests count as players. A player who just joined, or comes back from spectating, is not active before the first movement. Teleports, respawns and falling straight down are not movement.

The minimum player counts below use the same definition of active. A round that starts with fewer says so in chat.

**Connections:** in production at most 12 clients per IP by default address (IPv6: per /64) may be connected, so a lobby cannot be filled with one person's bots.

## Playtime

10 points for every 15 minutes of active online time, in every mode, carried over between maps and sessions. Time does not count while the player is AFK: no movement key, mouse or button input for 3 minutes. Holding one key or repeating the same input does not count as activity. Time spent spectating counts for at most 5 minutes in a row (until there is input while playing again). Input is read from the state packets: view movements, changes of run direction and ducks. Two in a row that were already seen in the same order in the last 10 minutes are a repetition.

## Race modes (surf, bhop)

Only validated runs count.

| Map | Finish |
| --- | --- |
| Easy surf | 4 |
| Easy bhop | 5 |
| Hard bhop | 12 |
| Hard surf | 15 |

- **Repeats** on the same map within one map session (until the map changes), and within 60 minutes whatever the sessions: 100 %, 50 %, 25 %, then 10 %, rounded up to whole points, so a finish never pays less than 1 (hard maps 2). The hour is there because a lone player can change the map at any time: two hard maps in turn would pay over 600 points per hour.
- **First finish ever** of a map: a bonus equal to the finish award. "Ever" means there was no stored run of the account on the map before this one, so maps finished before coins existed do not pay it.
- **Personal best** beaten: +2 once per map session and at most once per map in 60 minutes, after that +1. The first run is not a PB, an equal time neither.
- **Server record** beaten: +5 easy, +15 hard. Only when it beats another account's record, at most once per map per account per 24 hours. The first time on a map beats nobody. Of two equal times the older one holds the record.
- Guests' finishes only show the login hint.

The owner's suggestion (bhop 4, surf 2, hard surf 3) paid an easy map almost as much as a hard one. A hard map can take several map sessions to finish once, so it pays three to four times as much.

## Zombie Run

The mode has no numbered rounds; the gates are its steps. One run is one round of points, matching "round 2 gives 2, round 3 gives 3".

- **Gate *n*:** *n* points for each living survivor who passes it: the whole body is behind the gate on the route's side (or, after a gap in the position packets, in a checkpoint or the evac beyond it) while the gate is open. Once per player, gate and round; reconnecting or an account connected twice does not pay it again.
- **In order.** Only the next gate on the player's own way counts. Gates skipped by a late join at a checkpoint, by a fall-out teleport to a checkpoint further on, or by being behind a gate that is not open are never passed, also not by walking back through them.
- **Evac:** the number of gates + 3 (8 on Low Tide). The round ends when the first survivor reaches the boat, so it pays every living survivor who has passed the last gate by then, in that round, and at least half of all gates (3 of 5). Whoever joins for the last gates gets those gates but not the evac.
- **Turned.** A survivor who was turned keeps what they earned, and gets nothing more for gates or the evac in that round, also not when they come back as a survivor (reconnect, spectate).
- **As a player-zombie:** 1 point per survivor killed, each survivor once per round, at most 3 per run.
- **Repeats** of the same gate, and of the evac, on the same map within one map session and within 60 minutes whatever the sessions: 100 %, 50 %, 25 %, then 10 %, rounded up to whole points. A gate therefore never pays less than 1. Whole runs pay 23, 13, 8 and then 6.
- A lost round pays nothing by itself; the gates passed in it stay.
- More survivors mean more zombies, so there is no solo bonus or penalty.

The first draft only let the evac decay (100, 75, 50, 25 %). A round that is won takes 200 seconds on Low Tide (150 of them are gate countdowns), so that paid a good player over 350 points per hour, and an average one about 240.

## Zombie Defense

Account coins, not the gold of the mode. One wave is one round of points.

- **Wave *n* cleared:** 1 point for waves 1-3, then +1 every 4 waves (wave 4: 2, wave 8: 3, wave 12: 4), at most 5 from wave 16 on (`DEFENSE_PAY.wave`). Paid to every player who was in the game when the wave started and is still connected, dead or alive. Players who join during a wave wait for the next one and are not paid for it. An account connected twice is paid once.
- **Repeats** of the same wave number on the same map within one map session and within 60 minutes whatever the sessions: 100 %, 50 %, 25 %, then 10 %, rounded up to whole points (so waves 1-3 always pay 1). A lost game starts again from wave 1, so playing the first waves over and over pays little.
- A lost wave pays nothing. `MIN_ACTIVE` is 1 (solo play pays), and the player multiplier applies, as in the other co-op and multiplayer modes; more players also mean more zombies.

Estimate (solo, ×1.0, base points without playtime, shortest waves the rules allow, `economy.test.ts`): a game lost around wave 6-10 with full build phases pays 47-54 per hour (average player, 87-94 with playtime); reaching wave 20-30 pays 88-109 (128-149 with playtime), and with Ready pressed at once up to 130 (170). Losing on purpose at wave 2-3 and restarting pays 54-70 per hour. Real waves take longer, since every zombie has to be killed.

## Tag

Needs at least 3 active players. Rounds are 3 minutes.

- **Chased:** 1 point per 20 seconds as a runner while an IT is within 500 units, in line of sight, and both are moving. At most 3 per round. Hiding away from the action pays nothing.
- **Tags:** 1 point per different runner tagged, at most 3 per round. A runner who reconnects is the same one.
- **Placement,** with 4 or more players and a round played from the start: 3 / 2 / 1 points for the top three by time not IT. Players tied on that time (0.1 s, as shown) are ordered by how long they were chased; still tied players share the points of their places, rounded down, at least 1. Who was never IT and was chased for less than 10 s in the round takes no place: hiding pays nothing. Late joiners, and players who left or spectated in between, are skipped.
- **A round cancelled** by too few players pays no placement; chases and tags already paid stay.
- Coming within 64 units of a runner counts as a tag attempt for the `shadow` signal.

## Hide and seek

Needs at least 3 active players. Below that the mode pays nothing but playtime. Rounds are about 5 minutes.

- **Seeker chasing:** 1 point per 20 seconds of an active chase, at most 4 per round. A chase is: within 600 units, in line of sight, closing in or following, both moving.
- **Hider being chased:** 1 point per 10 seconds, at most 8 per round. The hider takes the risk, so it pays twice as fast.
- **Seeker finds a hider:** 3 points each.
- **Hider in plain view:** 2 points per 30 seconds seen by a seeker while staying in the same small area (within 128 units), at most 6 per round. Seen means in the seeker's field of view, in line of sight, within 2000 units. Moving to a new area restarts the 30 seconds. Chase time does not count twice.
- **Hider survives the round:** 5 points if any seeker saw them for 5 seconds or more in total, 2 points if never seen.
- **Seekers win:** 3 points for each player who started as a seeker and stayed one, if anyone was found (not when the hiders only left).
- **Cash bag:** once per round, halfway through the seeking phase, a bag with 4–10 coins (random) appears at a fixed, open, reachable spot near the middle of the map. Announced to everyone in chat and on the HUD. Only hiders can take it, by touch. Seekers can guard it. It stays until it is taken or the round ends. Each map declares the spot. It only appears with 3 or more active players at that moment.

Details (`apps/server/src/modes/hns.ts`):

- Only the seeking phase counts. Frozen or blindfolded seekers, and seekers who are AFK, see and chase nobody.
- A hider who is found keeps what they earned and is paid as a seeker from then on. Only the "Seekers win" bonus is for starters. Players who leave or spectate lose it.
- The time in plain view only runs while seen and not chased; being out of sight pauses it, leaving the 128 units restarts it.
- The bag is taken on the server, when a living hider's reported position (or the way between two packets, up to 128 units) is within 44 units of it. There is no client message. An impossible speed or jump is refused, and that hider must then be 256 units away before trying again, so waiting next to it does not help. A guest can take it without earning coins. If fewer than 3 players are active it stays where it is. What it holds is said only when it is taken.

Bot estimate (Lido Bay Medium, 6–12 bots, ×1.0, playtime included): average 85–115 points per hour, very good 142–158, always unseen 75–86. Rough: the bots' seekers are weak, and bots never pose in plain view. Getting found on purpose paid less than hiding normally at the same skill (71 against 101 for an average seeker, 104 against 113 for a very good one).

## Infected

Needs at least 4 active players. Rounds are 2–4 minutes.

- **Survivor kills:** 1 point per 4 infected killed, at most 4 per round. The same infected counts for at most 4 kills per survivor and round.
- **Infections:** 1 point per survivor infected, at most 5 per round; +1 for a bank shot, once per round. The whole lobby shares a stock of 16 payable infections that refills by 1 per 15 s of a running round: normal play does not notice it, rounds thrown away in seconds use it up.
- **Survive the round:** 4 points when at least half of the first survivors were infected and you killed at least one infected, else 2.
- **Last survivor alive when the survivors win:** +3, with the same conditions as the 4 points.
- **Specialist (7-kill streak):** 2 points, once per round, when the streak has kills of at least 2 different infected.
- **M.O.A.B. detonated:** 8 points to the caller once per map session, after that 1. Its victims count for nothing else. Surviving pays only when the normal clock (2 minutes) was played, so not after an earlier M.O.A.B.
- **Beacon smashed:** 1 point, once per round, for somebody else's beacon.
- **Infected win:** 2 points for Patient Zero, 1 point for every other infected who infected someone, when at least half of the normal clock was played.
- **Survivor first, infected later in the same round:** both halves pay. Kills, specialist, beacon and a called M.O.A.B. stay; from then on infections and the infected win count; surviving does not. Late joiners start as infected and are paid like the others.
- **A round cancelled** by too few players pays nothing for surviving or winning.
- **AFK:** 30 seconds without moving, as everywhere; a gunshot during the round counts as moving, so holding an angle and shooting is playing. Looking around or swinging the knife does not.

The limits beyond the first draft come from a bot simulation (2026-11-24, points per hour at ×1.0 including 40 playtime). Without them Patient Zero being let to infect everyone in seconds paid 240–249, an infected team that refuses to attack 144–152, protecting one survivor 156–160, and a very good player 198. With them: 54–59, 90–95, 108–110 and 142–166; average play 98–108. Tag: average 90–133, very good 134–186, hiding only the playtime. Bots on a simple arena, so rough.

The mode's own score (`+100` per kill and so on) stays as it is and only ranks players inside the round.

## Abuse and collusion

Detection must not be sensitive. Friends who play together, a bad seeker, a lucky streak or a shared IP address are normal. Nothing below bans on a single event.

**Prevention** (no punishment, the award is simply not paid):

- AFK players do not count towards minimum player counts and earn nothing.
- At most 12 connections per IP address by default in production, and one count per account.
- Caps and decay as listed per mode.
- A backstop of 250 points per rolling hour per account, counted before the multiplier, playtime included, excluding first-finish and record bonuses. What is left of it is paid. When it cuts or refuses an award, the player is told once per hour, with the minutes until more is paid.
- Awards are rejected for 5 seconds after a horizontal speed above the mode's sanity limit, or a jump in position faster than that limit that is not a respawn by the mode, a map spawn or a teleport destination. The limits (`SPEED_LIMIT`, units/s) are well above normal play, they are not the movement caps: hide and seek 600, Infected and Zombie Run 1000, tag 3500, surf and bhop 16384 (runs are validated anyway).

**Signals** (each adds strike weight):

| Signal | Weight |
| --- | --- |
| `shadow`: a seeker or IT stays within 100 units of the same target, looking at it and able to hit it (no glass or wall between), for 20 s without a swing or tag attempt, while the target earns points from them | 2 for the hunter, 1 for the target |
| `concentration`: more than 70 % of an account's chase or view points (6 or more) over 3 rounds come from one other account that is part of each of the 3, with 5 or more players available | 1, the earning account only |
| `contact`: the same pair tags, finds or infects each other 4 or more times within 60 s, with 5 or more players available | 1 each |
| `ipFeed`: a player on the same IP address who never acts in the round feeds an account 2 or more points, 3 rounds in a row | 2 each |
| `macro`: 10 minutes with 100 or more inputs of which 5 % or less are different, while points are earned in both halves | 2 |
| `impossible`: an award request the server has to reject as impossible (only where a client can trigger one) | 1 |

Changes to the first draft, because it flagged normal play: in the original form three friends in a small tag game would have been warned within minutes (`contact` every minute), a hider could have been banned because of a seeker who trolls them (`shadow`), and a round with one seeker makes 100 % of every hider's points come from that seeker. Therefore the conditions above, and the repeat limit below. Guests can be a partner in a signal but never get strikes.

**Response:**

- The same signal counts once per account and minute; `contact` and `concentration` once per 10 minutes, so alone they never reach a warning.
- Strikes decay by 1 every 10 minutes.
- At 3: a private warning. The warned account's awards are paused for 5 minutes (playtime is not), and so are those its partner earns from it.
- At 5, with signals from at least 2 different rounds or 2 different signal types and at least 30 s after a warning: a 5-minute ban, with the reason and the time left shown. It lifts by itself, strikes reset to 2, and the next ban needs a new warning. Strikes live in memory and are lost when the server restarts; bans are stored.
- Every warning and ban goes into an admin-visible log with its evidence. Points already earned stay; only admins can remove them.
- Admin accounts are logged but never banned automatically.

## Feedback to the player

Every award shows a small, non-blocking popup with the amount, the reason and the multiplier (for example `+4.5 coins · Found a hider · ×1.5`). Awards that arrive together are stacked. Outside the multiplayer modes the multiplier reads `×1.0`. The current multiplier and the active player count are also visible in the right-side panel. The Esc menu shows coins, lifetime points and the latest awards.

Guests see "Log in or register to earn coins for this." once per session, the first time they would have earned something.

## Implementation

| File | Job |
| --- | --- |
| `packages/shared/src/casino.ts`, `apps/server/src/casino.ts` | [Casino](#casino): odds and rules / rolls, bets, crash rounds |
| `packages/shared/src/economy.ts` | All numbers, the reasons (`AWARDS`), multiplier, decay and formatting |
| `packages/shared/src/modes/hunt.ts` | `HuntTracker` (chase, view, shadow), `buildSight`, `TimeMeter` |
| `apps/server/src/economy.ts` | `Economy`: the only place that pays; `ModeEconomy` for the modes; finds the abuse signals |
| `apps/server/src/activity.ts` | Activity, input and suspect movement per connection |
| `apps/server/src/abuse.ts` | Strikes, decay, warning, pause, ban decision |
| `apps/server/src/economy-helpers.ts` | Simulated lobby for tests |
| `apps/server/src/payout-helpers.ts` | A real mode on that lobby for the payout tests |
| `apps/web/src/lib/game/coins.ts` | Popups and the Coins view on the client |

### Storage

All in the game server's SQLite, amounts in tenths. Migrations are additive: new tables, and two new columns with a default. An older server can still open the database; it only ignores the expiry of a running temporary ban.

| Table | Columns |
| --- | --- |
| `account_stats` | as before, plus `active_ms` (active time towards the next playtime points) |
| `bans` | as before, plus `expires_at` (wall clock ms; null = permanent) |
| `point_log` | `account_id`, `created_at`, `mode`, `map`, `reason`, `label`, `base`, `counted` (towards the backstop), `multiplier`, `amount` (negative for purchases and admin removals) |
| `casino_log` | `account_id`, `created_at`, `game`, `bet`, `payout`: settled casino bets, the newest 30 per account |
| `casino_stats` | `account_id`, `plays`, `bet`, `payout`: sums of all bets ever (the net result) |
| `casino_crash` | `id`, `account_id` (unique), `created_at`, `bet`: open crash bets |
| `point_rollup` | `account_id`, `mode`, `reason`, `entries`, `base`, `amount`: sums of deleted log rows. `point_log` keeps the newest 30 rows per account, plus those of the last 25 hours, which the limits on repeated awards count |
| `abuse_log` | `created_at`, `account_id`, `username`, `action` (`warning`, `ban`, `exempt`), `strikes`, `evidence`; the latest 2000 rows. No IP addresses |

Totals, log row and (for playtime) the rest of the active time are written in one transaction. Active time is written every 60 s, when the account leaves and at shutdown.

### Admin changes

An admin can add to, subtract from or reset an account's balance, online or offline (`Economy.adjust`, at most 100,000 coins at once). Only the coin balance changes, never the lifetime points. It never goes below zero: subtracting more takes what is there. Each change is one transaction with a `point_log` row (mode and reason `admin`, not counted towards the backstop, no multiplier) and an `admin_log` row. The player sees it at once as a notice and in the Coins view. Bought items stay.

### Wire

Additive; older clients ignore the messages, newer clients show nothing without them. Amounts and multipliers are tenths.

| Direction | Message |
| --- | --- |
| S→C | `coins { total, balance, recent[{ at, reason, label, amount, mult }] }`: after `welcome`, `auth` and every change that is no award; the latest 30 entries, casino bets included (`casino:<game>`) |
| S→C | `award { at, reason, label, base, mult, amount, total, balance }`: to the player who earned it |
| S→C | `multiplier { mult, active, need }`: on join and every change, to everyone; `need` = active players this mode needs to pay |
| S→C | `coinsNotice { text, tone: info\|warn }`: guest hint and abuse warning (also sent as a chat line for older clients), welcome bonus, hourly limit, refunded crash bet |
| S→C | `banned { reason, seconds? }`: `seconds` until the ban lifts by itself; absent = permanent |
| C→S, S→C | Shop messages: see [Shop](#shop); casino messages: see [Casino](#casino) |
| S→C | `adminState`: `bans[].secondsLeft?`, `abuse[]?`, `players[].coins?` |

<a id="paying-from-a-mode"></a>

### Paying from a mode

A mode calls `host.economy` (`ModeEconomy`) and nothing else. Every rule of this document that is not about the mode's own game is applied there: guests, AFK, spectators, minimum players, multiplier, caps per round and session (from `AWARDS`), backstop, suspect movement, abuse pause. So a mode just calls `award`, and never checks these itself.

| Call | Meaning |
| --- | --- |
| `award(playerId, base, reason, { against?, label? })` | Pay `base` tenths (the `*_PAY` constants, or `pts(3)`). `against`: the player it was earned from; **always pass it when there is one**. `label`: instead of the reason's text (`Gate 3`). Returns `{ paid, refused? }` |
| `roundStart()` / `roundEnd()` | Per-round caps and tallies start over / the round's abuse checks run. Call `roundEnd` after the last award of the round |
| `tally(playerId, key, 'round' \| 'session')` | Count something; returns the count so far. Survives a reconnect. `tallied(...)` reads it |
| `earned(playerId, reason, 'round' \| 'session')` | Base tenths paid so far |
| `sinceLastPaid(playerId, reason)` | ms since the last time on this map, or null (the 24 h record rule) |
| `paidWithin(playerId, reason, ms, label?)` | How often it was paid on this map in the last `ms`, across map sessions (repeat decay) |
| `activePlayers()`, `isActive(playerId)`, `multiplier()`, `enoughPlayers(reason?)` | Current values |
| `contact(byId, targetId)` | Call for **every** tag, find or infection, paid or not |
| `report('shadow', [hunterId, targetId], evidence)`, `report('impossible', [playerId], evidence)` | Abuse evidence |
| `acted(playerId)` | A verified action that counts as moving for the 30 s (Infected: a gunshot); not input for playtime |
| `teleported(playerId)` | Only for a move that is neither a `spawn` event sent with `host.send` (`zm`, `inf`, `hns`) nor to a spawn or destination of the map |

A map session is one mode instance: from map change to map change, extensions included. Its handle stops paying afterwards. Outside a round (before the first `roundStart`) the caps of `AWARDS` run for the whole session.

Optional on `ServerMode`: `stillness(p)` returns `'held'` while the game keeps a player from moving, `'look'` when looking around is enough, else null. Hide and seek (frozen; everyone in a round), Zombie Run and Infected (dead) have it.

A repeated race finish and a first one:

```ts
const n = Math.max(host.economy.tally(p.id, 'finish', 'session') - 1, host.economy.paidWithin(p.id, 'raceFinish', REPEAT_MS)); // earlier finishes
host.economy.award(p.id, decayed(raceFinish(host.map), RACE_PAY.repeat, n), 'raceFinish');
if (firstEver) host.economy.award(p.id, raceFinish(host.map), 'raceFirst');
```

<a id="chase-and-view"></a>

Chases in a mode with hunters and targets (tag: `chaseRange: HUNT_RANGE.tagChase`, no `pursuit`, no `viewRange`):

```ts
// constructor
this.hunt = new HuntTracker({ sight: buildSight(host.map), chaseRange: HUNT_RANGE.hnsChase, pursuit: true, viewRange: HUNT_RANGE.hnsView });
this.chased = new TimeMeter(HNS_PAY.hiderChased.everyMs);

// every tick of the round; bodies from p.state: { id, x, y, z, yaw, pitch, ducked }
const s = this.hunt.update(host.now(), seekers, hiders);
if (s) {
	for (const [id, e] of s.chased)
		if (this.chased.add(id, e.ms) > 0) host.economy.award(id, HNS_PAY.hiderChased.points, 'hnsChased', { against: e.by });
	for (const { hunter, target } of s.shadows) host.economy.report('shadow', [hunter, target], '20 s without a swing');
}

// on a swing, tag or hit, and at round start
this.hunt.attempt(seekerId);
this.hunt.reset();
this.chased.reset();
```

`s.chasing` is the same per hunter and `s.seen` the targets in view. A target with several hunters is credited once, by the nearest. `HuntTracker` samples 4 times per second, uses at most 96 traces per sample, and measures speed from positions. The line of sight treats fake walls (`solid: false`) as opaque and glass as transparent.

<a id="shop"></a>

## Shop

Cosmetics only. The stock, the rarities and their prices are data in `packages/shared/src/cosmetics.ts` ([how to add an item](characters.md#adding-an-item)); the rules are in `apps/server/src/shop.ts`. Menu: [ui.md](ui.md#shop).

- **Rarity** sets the price. `basic` is 30 coins (300 tenths). `common`, `uncommon`, `rare` and `epic` have no price: not in the shop, only meant for loot boxes.
- <a id="loot-box"></a>**Loot box** (`LOOTBOX`, 80 coins): holds every item of common rarity or better. `rollLoot` picks the rarity by weight (common 80, uncommon 10, rare 5, epic 1; they add up to 96, so with all four present the real chances are 83.3 / 10.4 / 5.2 / 1.0 %), then any of its items equally. Rarities without items would drop out (`lootChances`). The menu shows the real chances and everything inside: 32 common, 16 uncommon, 16 rare (4 suit pieces, 2 masks, 10 auras) and 4 epic items.
  - The server rolls (`Shop.openBox`, `node:crypto`), and `Db.openBox` takes the price and grants the item in one transaction. The client's reel only shows the result, so closing it early loses nothing.
  - **Duplicates** can come up, and give coins back instead: common 20, uncommon 40, rare 60, epic 80 (`LOOTBOX.refund`; logged as `Duplicate: <name>`, no lifetime points). Once an account owns everything in the box, opening is refused and nothing is charged.
  - **News**: everyone on the server hears what came out, but only after the opener has seen it. The opener's client sends `boxRevealed` when the result shows (end of the reel, skip, or leaving the screen). `Shop.announce` then broadcasts the result the server kept for that connection, once, so the client never says what it got. It announces by itself after 12 s (`BOX_NEWS_MS`, older clients), on disconnect and when the next box is opened. Rare and epic items are also said in chat. Shown as in [ui.md](ui.md#box-news).
  - Model: `apps/web/src/lib/render/lootbox.ts`; menu: [ui.md](ui.md#lootbox).
- **Buying** (`Db.buyItem`) is one transaction that takes the write lock first: not owned yet, balance suffices, deduct, log `shop:<id>` (label `Shop: <name>`), grant. A second click, tab or process gets "You already own this item". No refunds.
- **Shop and inventory** are two menus on the same messages. The shop lists only what has a price (owned items last, marked "Owned") and never changes what you wear, except through "Wear it" right after a purchase. The [inventory](ui.md#inventory) lists everything the account owns, of any rarity, also what the server no longer sells, plus the default look of each slot; wearing and taking off happen there.
- **Wearing**: owned items only, one per slot, in the item's own slot; `null` takes it off. Kept across sessions, maps and modes.
- **Guests** see the stock and can try items on, but not buy or wear them, and have no inventory.
- At most 8 requests per second and connection; more are refused, above 100 the client is kicked.
- **Storage** (new tables, nothing else changes): `owned_items (account_id, item_id, bought_at, price)` and `equipped (account_id, slot, item_id)`, which references `owned_items`. Rows of items this version does not know are kept and ignored.

| Direction | Message |
| --- | --- |
| C→S | `shopBuy { item }` |
| C→S | `shopEquip { slot, item \| null }` |
| C→S | `boxOpen {}` |
| S→C | `boxResult { ok: true, item, duplicate, refund }` (tenths) or `{ ok: false, error }`: to the requester |
| C→S | `boxRevealed {}`: the opener has seen the result; ignored without one waiting |
| S→C | `boxNews { id, name, item, duplicate }`: to everyone, the opener included |
| S→C | `shop { items[{ id, price }], owned[], loadout, box?: { price, odds, items[] } }` (no `box`: no loot box shown): after `welcome`, `auth` and every change; guests get it with nothing owned |
| S→C | `shopResult { action: buy\|equip, item, ok, error? }`: to the requester |
| S→C | `cosmetics { id, loadout }`: to everyone when a player's worn items change (also on login and logout) |
| S→C | `welcome.players[]` and `join.player` carry `loadout?` (absent: default look) |

All of it is optional: older clients ignore it, and without `shop` a newer client says the shop and the inventory are not available on this server. The server's prices are the ones shown and charged.

<a id="casino"></a>

## Casino

Three games in the Esc menu, for logged-in accounts; guests can look. Coins are virtual, earned by playing and never bought. Odds and rules: `packages/shared/src/casino.ts`; server: `apps/server/src/casino.ts`; menu: [ui.md](ui.md#casino). The owner set the chances as the chance to win.

| Game | Bet | Odds |
| --- | --- | --- |
| Coinflip | 10–500 | Exactly 50 %, a win pays 2×. Payback 100 % |
| Crash | 5–500 | P(reaching *m*) = 1/*m* (2×: 50 %), capped at 100×. Payback 100 % before rounding |
| Slots | 1–500 | 48.95 % of spins pay something, 20.7 % more than the bet. Payback 97.86 %, counted exactly over all 32³ combinations in `casino.test.ts` |

- **Crash:** the multiplier doubles every 6 s (`crashCurve`). The crash point is rolled at the bet, in hundredths, and sent only at the end. A cash-out counts at the multiplier when the server receives it, rounded down to 0.01×; the optional automatic cash-out (1.01×–100×) pays exactly its value and wins a tie with the crash. At 100× it is paid out by itself. Payouts are rounded down to 0.1 coin. One round per account, across tabs and reconnects.
- **Disconnect:** the round goes on; the automatic cash-out still counts, without one the bet is lost at the crash.
- **Restart:** open crash bets are in `casino_crash` and are given back when the server starts, with a notice. A round can only be paid while its row exists, so never twice.
- **Slots:** three equal, independent reels of 32 stops. Two or three equal symbols anywhere on the line pay a multiple of the bet:

| Symbol | Stops | Two | Three |
| --- | --- | --- | --- |
| Wave | 9 | 1× | 4× |
| Shell | 7 | 1× | 6× |
| Palm | 6 | 2× | 10× |
| Fin | 4 | 2× | 15× |
| Board | 3 | 3× | 25× |
| Sun | 2 | 5× | 50× |
| Pearl | 1 | 10× | 250× |

- **Rules:** bets are whole coins; `CASINO_MIN` and `CASINO_MAX_BET` (500). Every outcome is rolled with `node:crypto` (`secureRandom`); the roll functions take the random source, so tests and the dev mock use the same code. Taking the bet, paying and logging are one transaction (`Db.casinoPlay`); for crash the bet is taken at the start (`crashOpen`) and the payout is paid at the end (`crashClose`). The balance never goes below zero.
- **Only the balance changes:** no lifetime points, no `point_log` row (the Coins view merges `casino_log` in), nothing towards playtime, backstop or abuse detection. `casino_log` keeps the newest 30 bets per account, `casino_stats` the sums for the net result.
- At most 5 requests per second and connection; more are refused, above 100 the client is kicked.

| Direction | Message |
| --- | --- |
| C→S | `casinoBet { game, bet }`, whole coins; coinflip also `side: heads\|tails`, crash also `auto` (hundredths or null) |
| C→S | `crashCashout {}` |
| S→C | `casino { min, max, net, recent[{ at, game, bet, payout }], crash?: { bet, auto, elapsed } }`: after `welcome` and `auth`. `min` and `max` in whole coins; the rest in tenths; `crash`: the running round |
| S→C | `crashStart { bet, auto }`: the bet is taken, the curve starts |
| S→C | `casinoResult { ok: true, game, bet, payout, net, … }` (`picked`, `side` / `reels` / `at`, `crash`) or `{ ok: false, game, error }` |
| S→C | `casinoNews { id, name, game, bet, payout }` (tenths): a win of 5× the bet or more, to everyone; slots 3 s later (`SLOTS_NEWS_MS`, when the reels have stopped), not when the winner is offline by then. From 20× also a chat line |

All of it is optional: older clients ignore it, and without `casino` a newer client says the casino is not available on this server. The new balance comes as `coins`.

### Spending from code

`Economy.spend(accountId, amount, item)` (`lobby.economy`) takes tenths from the balance in one transaction, never below zero, logs `shop:<item>` and sends `coins`. It returns false when the balance is too low. `Economy.buy(accountId, item)` is the same for a shop item, with the grant in the same transaction. The Coins view is `apps/web/src/lib/ui/menu/CoinsMenu.svelte`.
