/**
 * Tournament gamemode (docs/modes.md#tournament). Server-authoritative: the
 * shared `TournamentGame` (phases, bracket, duel rounds, HP, lag-compensated
 * hits, the deck knife fights, the bet book) runs here on the latest state
 * packets; clients send `fire` / `knife` / `reload` / `loadout` / `trnBet`
 * and display the results.
 *
 * Coins (docs/economy.md#tournament): duel kills and the champion are paid
 * through `host.economy.award`; bets take and pay coins through
 * `host.economy.betOpen` / `betClose` (the casino path: no points, no backstop).
 */
import type { MapRecordInfo, NetState, ScoreRow, ServerMessage, TrnEvent, TrnOut, TrnSettlement } from '@surf/shared';
import {
	buildCollisionWorld,
	FLAG_DUCKED,
	FLAG_ON_GROUND,
	FLAG_TELEPORTED,
	INF_HISTORY_MS,
	formatTenths,
	infRewindMs,
	POINTS_SCALE,
	pts,
	SPEED_LIMIT,
	Status,
	TOURNAMENT_PAY,
	TournamentGame,
	TRN_BET,
	TRN_BET_MIN_ENTRANTS,
	TRN_BET_STAKE,
	TRN_ROUND_WINS,
	WEAPONS,
	type TrnGameOptions
} from '@surf/shared';
import type { Command } from '../commands.ts';
import { parseInfInput } from './infected-input.ts';
import type { ModeClientMessage, ModeHost, ModePlayer, ServerMode } from './types.ts';
import { EMPTY_RECORDS, renderRewindMs } from './types.ts';

/** Mode state is re-sent at least this often (ms), and at most this often on minor changes. */
export const TRN_STATE_MS = 1000;
export const TRN_STATE_MIN_MS = 250;
/** Shots are void this long after a state packet over the mode's speed limit (ms). */
export const TRN_SPEED_PENALTY_MS = 1000;

export type TournamentModeOptions = Pick<TrnGameOptions, 'startSecs' | 'bracketSecs' | 'freezeSecs' | 'roundSecs' | 'roundEndSecs' | 'nextSecs' | 'minPlayers'>;

/** Events that change what everyone sees: state goes out at once. */
const URGENT = new Set<TrnEvent['e']>(['start', 'duelStart', 'roundStart', 'roundEnd', 'duelEnd', 'kill', 'champion']);

export class TournamentMode implements ServerMode {
	readonly id = 'tournament' as const;
	readonly game: TournamentGame;
	private lastSent = -Infinity;
	private dirty = true;
	private urgent = false;
	/** Last state packet over the speed limit, per player (ms). */
	private readonly overCap = new Map<number, number>();
	/** Duels won and duel kills on this map, by person (account or player id): the scoreboard. */
	private readonly duelsWon = new Map<string, number>();
	private readonly kills = new Map<string, number>();
	private phaseSaid = 'waiting';
	private disposed = false;

	constructor(
		private readonly host: ModeHost,
		opts: TournamentModeOptions = {}
	) {
		const map = host.map;
		this.game = new TournamentGame({
			...opts,
			map,
			world: buildCollisionWorld(map),
			now: host.now(),
			rng: () => host.rng(),
			lenient: true
		});
	}

	join(p: ModePlayer): void {
		this.tick();
		this.host.send(p, this.stateMessage());
		this.host.systemTo(
			p,
			'Tournament: 1v1 duels, single elimination. Duelists fight in the arena with sniper, pistol and knife (1-3 to switch, R reloads); first to 2 round wins advances. ' +
				`Everyone else watches from the glass deck with a knife, and logged-in spectators can bet ${TRN_BET} coins on a duel (brackets of ${TRN_BET_MIN_ENTRANTS}+).`
		);
		if (this.game.bracket) this.host.systemTo(p, 'A tournament is running: you watch from the deck until the next one.');
	}

	leave(p: ModePlayer): void {
		this.overCap.delete(p.id);
		this.tick();
	}

	/** Spectating the lobby counts as leaving the tournament (a duelist forfeits). */
	spectate(): void {
		this.tick();
	}

	state(p: ModePlayer, s: NetState): void {
		const now = this.host.now();
		this.game.setPos(p.id, {
			x: s.x,
			y: s.y,
			z: s.z,
			ducked: (s.flags & FLAG_DUCKED) !== 0,
			yaw: s.yaw,
			pitch: s.pitch,
			vx: s.vx,
			vy: s.vy,
			vz: s.vz,
			onGround: (s.flags & FLAG_ON_GROUND) !== 0
		}, (s.flags & FLAG_TELEPORTED) !== 0);
		const limit = SPEED_LIMIT.tournament;
		const speed = Math.hypot(s.vx, s.vy);
		if (speed > limit) {
			const prev = this.overCap.get(p.id) ?? -Infinity;
			if (now - prev > 5000) this.host.log(`tournament: #${p.id} ${p.name} over the ${limit} u/s limit (${Math.round(speed)})`);
			this.overCap.set(p.id, now);
		}
	}

	zone(): void {}

	records(): MapRecordInfo {
		return { ...EMPTY_RECORDS };
	}

	/** fire / knife (a swing) / reload / loadout from a player on the map; trnBet from anyone. */
	message(p: ModePlayer, msg: ModeClientMessage): void {
		if (msg.type === 'trnBet') return this.bet(p, msg.pick);
		if (p.spectating || !this.game.has(p.id)) return;
		const now = this.host.now();
		const raw = msg.type === 'knife' ? { type: 'fire', weapon: 'knife', origin: msg.origin, dir: msg.dir, renderServerTimeMs: msg.renderServerTimeMs } : msg;
		const input = parseInfInput(raw);
		if (!input) return;
		switch (input.type) {
			case 'fire': {
				if (now - (this.overCap.get(p.id) ?? -Infinity) < TRN_SPEED_PENALTY_MS) return;
				// The poses on the shooter's screen (netcode v3 render time), else ping + interpolation delay.
				const rewindMs = renderRewindMs(input.renderServerTimeMs, this.host.serverNow?.() ?? now, p, INF_HISTORY_MS, infRewindMs(p.ping));
				const res = this.game.fire(p.id, { weapon: input.weapon, origin: input.origin, dir: input.dir, rewindMs }, now);
				// Holding an angle and shooting is playing (docs/economy.md): a real duel shot.
				if (res.ok && this.game.isDuelist(p.id) && WEAPONS[input.weapon].magazine > 0) this.host.economy.acted(p.id);
				this.dispatch(res.out);
				break;
			}
			case 'reload':
				this.dispatch(this.game.reload(p.id, now));
				break;
			case 'loadout':
				this.dispatch(this.game.selectWeapon(p.id, input.weapon, now));
				break;
			default:
				return;
		}
		this.flushState(now);
	}

	command(p: ModePlayer, cmd: Command): boolean {
		if (cmd.cmd !== 'top' && cmd.cmd !== 'pb') return false;
		const k = this.person(p);
		this.host.systemTo(p, `No leaderboard in the tournament. On this map: ${this.duelsWon.get(k) ?? 0} duels won, ${this.kills.get(k) ?? 0} duel kills.`);
		return true;
	}

	scoreRows(): ScoreRow[] {
		const g = this.game;
		const rows: ScoreRow[] = [];
		for (const p of this.host.players()) {
			const entrant = !p.spectating && g.isEntrant(p.id);
			const k = this.person(p);
			rows.push({
				id: p.id,
				name: p.name,
				rank: null,
				pbTicks: null,
				status: !entrant ? Status.Spectating : g.isOut(p.id) ? Status.Down : Status.Alive,
				stage: 0,
				ping: Math.round(p.ping),
				spectating: p.spectating,
				score: this.duelsWon.get(k) ?? 0,
				kills: this.kills.get(k) ?? 0
			});
		}
		rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.kills ?? 0) - (a.kills ?? 0) || a.name.localeCompare(b.name));
		return rows;
	}

	/** Frozen duelists are held; watching from the deck is looking around. */
	stillness(p: ModePlayer): 'held' | 'look' | null {
		if (this.game.isFrozen(p.id)) return 'held';
		return this.game.isDuelist(p.id) ? null : 'look';
	}

	tick(): void {
		if (this.disposed) return;
		const now = this.host.now();
		const list = [];
		for (const p of this.host.players()) if (!p.spectating) list.push({ id: p.id, name: p.name, accountId: p.accountId });
		this.dispatch(this.game.syncPlayers(list, now));
		this.dispatch(this.game.update(now));
		this.announcePhase();
		this.flushState(now);
	}

	stateMessage(): Extract<ServerMessage, { type: 'modeState' }> {
		return { type: 'modeState', mode: 'tournament', ...this.game.view(this.host.now()) };
	}

	/** The tournament stops with the map: open bets are given back. */
	dispose(): void {
		if (this.disposed) return;
		this.dispatch(this.game.cancel(this.host.now()));
		this.disposed = true;
	}

	// -----------------------------------------------------------------------

	private flushState(now: number): void {
		if (this.urgent || (this.dirty && now - this.lastSent >= TRN_STATE_MIN_MS) || now - this.lastSent >= TRN_STATE_MS) {
			this.lastSent = now;
			this.dirty = false;
			this.urgent = false;
			this.host.broadcast(this.stateMessage());
		}
	}

	private player(id: number | null): ModePlayer | null {
		if (id === null) return null;
		for (const p of this.host.players()) if (p.id === id) return p;
		return null;
	}

	private name(id: number | null): string {
		const p = this.player(id);
		if (p) return p.name;
		const e = id === null ? undefined : this.game.bracket?.entrants.find((x) => x.id === id);
		return e?.name ?? `Player ${id}`;
	}

	/** Same person across reconnects and double connections. */
	private person(p: ModePlayer): string {
		return p.accountId !== null ? `a${p.accountId}` : `g${p.playerId}`;
	}

	private add(map: Map<string, number>, id: number): void {
		const p = this.player(id);
		if (!p) return;
		const k = this.person(p);
		map.set(k, (map.get(k) ?? 0) + 1);
	}

	/** A bet on a duelist of the current or next duel. */
	private bet(p: ModePlayer, pick: unknown): void {
		const reply = (ev: Extract<TrnEvent, { e: 'bet' }>) => this.host.send(p, { type: 'trn', ev });
		const r = this.game.betCheck({ id: p.id, accountId: p.accountId }, pick);
		const shown = typeof pick === 'number' && Number.isInteger(pick) ? pick : null;
		if (!r.ok) return reply({ e: 'bet', ok: false, match: r.match, pick: shown, reason: r.reason });
		const accountId = p.accountId!;
		const ticket = this.host.economy.betOpen(accountId, TRN_BET_STAKE);
		if (ticket === null) return reply({ e: 'bet', ok: false, match: r.match, pick: shown, reason: 'coins' });
		this.game.placeBet(accountId, r.match, pick as number, ticket, TRN_BET_STAKE);
		reply({ e: 'bet', ok: true, match: r.match, pick: pick as number });
		this.host.systemTo(p, `Bet placed: ${TRN_BET} coins on ${this.name(pick as number)}.`);
		this.dirty = true;
		this.flushState(this.host.now());
	}

	/** Pay out or give back decided bets, whether the bettor is online or not. */
	private settle(list: TrnSettlement[]): void {
		for (const s of list) {
			if (!this.host.economy.betClose(s.ticket, s.payout, s.outcome)) {
				this.host.log(`tournament: bet ${s.ticket} of account ${s.accountId} was not open any more`);
				continue;
			}
			const ev: TrnEvent = { e: 'betResult', match: s.match, outcome: s.outcome, payout: s.payout / POINTS_SCALE };
			for (const p of this.host.players()) {
				if (p.accountId !== s.accountId) continue;
				this.host.send(p, { type: 'trn', ev });
				const text =
					s.outcome === 'won'
						? `Your bet on ${this.name(s.pick)} won: ${formatTenths(s.payout)} coins.`
						: s.outcome === 'lost'
							? `Your bet on ${this.name(s.pick)} lost.`
							: `Your bet of ${formatTenths(s.stake)} coins was given back (no duel was decided).`;
				this.host.systemTo(p, text);
			}
		}
	}

	private dispatch(out: TrnOut[]): void {
		const h = this.host;
		for (const o of out) {
			const msg: ServerMessage = { type: 'trn', ev: o.ev };
			if (o.to) {
				for (const p of h.players()) if (o.to.includes(p.id)) h.send(p, msg);
			} else if (o.except !== undefined) {
				for (const p of h.players()) if (p.id !== o.except) h.send(p, msg);
			} else h.broadcast(msg);
			if (URGENT.has(o.ev.e)) this.urgent = true;
			else if (o.ev.e === 'hit') this.dirty = true;
			this.pay(o.ev);
			this.announce(o.ev);
		}
		this.settle(this.game.takeSettlements());
	}

	/** Coins of a rules event (docs/economy.md#tournament). */
	private pay(ev: TrnEvent): void {
		const eco = this.host.economy;
		switch (ev.e) {
			case 'duelStart':
				eco.roundStart();
				break;
			case 'duelEnd':
				if (ev.result !== 'bye') eco.roundEnd();
				break;
			case 'kill':
				if (ev.deck) break;
				this.add(this.kills, ev.by);
				eco.contact(ev.by, ev.target);
				eco.award(ev.by, TOURNAMENT_PAY.kill, 'trnKill', { against: ev.target });
				break;
			case 'champion': {
				if (ev.prize <= 0) break;
				const r = eco.award(ev.id, pts(ev.prize), 'trnChampion');
				if (r.paid === 0) this.host.log(`tournament ${ev.tournament}: champion #${ev.id} prize not paid (${r.refused ?? 'unknown'})`);
				break;
			}
		}
	}

	private announcePhase(): void {
		const phase = this.game.phase;
		if (phase === this.phaseSaid) return;
		const was = this.phaseSaid;
		this.phaseSaid = phase;
		this.urgent = true;
		if (phase === 'waiting') this.host.system(was === 'starting' ? 'Not enough players: the tournament needs 2+.' : 'Waiting for players: the tournament needs 2+.');
		else if (phase === 'starting') this.host.system(`A tournament starts in ${Math.round(this.game.view(this.host.now()).timeLeft)} s.`);
	}

	private announce(ev: TrnEvent): void {
		const h = this.host;
		switch (ev.e) {
			case 'start': {
				h.system(`Tournament ${ev.tournament}: ${ev.entrants} entrants, single elimination, first to ${TRN_ROUND_WINS} round wins. The champion wins up to ${ev.prize} coins.`);
				h.log(`tournament ${ev.tournament} start entrants=${ev.entrants}`);
				break;
			}
			case 'duelStart': {
				const bets = this.game.betMatch() === ev.match ? ` Bets are open until the first round starts (${TRN_BET} coins).` : '';
				h.system(`Next duel: ${this.name(ev.a)} vs ${this.name(ev.b)}.${bets}`);
				break;
			}
			case 'roundEnd':
				if (ev.reason === 'draw') h.system(`Round ${ev.round}: time is up with equal health. The round is played again.`);
				else h.system(`Round ${ev.round} to ${this.name(ev.winner)}${ev.reason === 'time' ? ' (more health when time ran out)' : ''}. ${ev.wins[0]}-${ev.wins[1]}.`);
				break;
			case 'duelEnd':
				if (ev.result === 'rounds') {
					this.add(this.duelsWon, ev.winner);
					h.system(`${this.name(ev.winner)} beats ${this.name(ev.loser)} and advances.`);
				} else if (ev.result === 'forfeit') {
					h.system(`${this.name(ev.winner)} advances: ${ev.loser === null ? 'no opponent' : `${this.name(ev.loser)} left`}.`);
				}
				break;
			case 'champion':
				h.system(
					ev.prize > 0
						? `${this.name(ev.id)} wins tournament ${ev.tournament}! Prize: ${ev.prize} coins (${ev.entrants} players fought). Next tournament in a few seconds.`
						: `${this.name(ev.id)} wins tournament ${ev.tournament}! No prize: fewer than 2 players fought a round.`
				);
				h.log(`tournament ${ev.tournament} champion=${ev.id} fought=${ev.entrants} prize=${ev.prize}`);
				break;
		}
	}
}
