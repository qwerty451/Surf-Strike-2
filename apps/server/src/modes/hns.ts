/**
 * Hide and seek gamemode (docs/modes.md#hide-and-seek). Server-authoritative:
 * the shared `HnsGame` (round flow, seeker picks, freeze, knife hits with lag
 * compensation, conversions, win conditions) runs here on the latest state
 * packets; clients send `knife` swings and display the results. Positions stay
 * client-authoritative as in the other modes, but frozen seekers are pulled
 * back to their spawn and over-cap speeds void knife swings.
 *
 * Coins (docs/economy.md#hide-and-seek): who chases and sees whom, finds,
 * survivals, the seekers' win and the cash bag are worked out here and paid
 * through `host.economy`, which applies every general rule.
 */
import type { HnsEvent, HuntBody, HuntSample, MapRecordInfo, NetState, ScoreRow, ServerMessage } from '@surf/shared';
import {
	buildCollisionWorld,
	buildSight,
	FLAG_DUCKED,
	FLAG_TELEPORTED,
	formatTenths,
	HNS_PAY,
	HNS_MAX_REWIND_MS,
	HnsGame,
	HNS_SPEED_LIMIT,
	HUNT_RANGE,
	HuntTracker,
	INTERP_DELAY_MS,
	MIN_ACTIVE,
	overSpeedCap,
	POINTS_SCALE,
	SNAPSHOT_HZ,
	Status,
	TimeMeter,
	type HnsGameOptions,
	type Vec3
} from '@surf/shared';
import type { Command } from '../commands.ts';
import type { ModeClientMessage, ModeHost, ModePlayer, ServerMode } from './types.ts';
import { EMPTY_RECORDS, renderRewindMs } from './types.ts';

/** Mode state is re-sent at least this often (ms). */
export const HNS_STATE_MS = 1000;
/** Client-side interpolation delay of remote players (INTERP_DELAY_MS) plus half a snapshot interval, in whole ms: 100 + 16. */
export const HNS_VIEW_DELAY_MS = INTERP_DELAY_MS + Math.round(1000 / SNAPSHOT_HZ / 2);
/** A seeker's swings are void this long after a state packet over the speed cap. */
export const HNS_SPEED_PENALTY_MS = 1000;

/** After a refused bag (suspect jump or speed) a hider must first be this far away from it again. */
export const HNS_BAG_RETRY_DIST = 256;

export type HnsModeOptions = Pick<HnsGameOptions, 'startSecs' | 'hideSecs' | 'seekSecs' | 'endSecs' | 'foundFreezeSecs'>;

/** Round lengths from the environment (HNS_HIDE_SECS, HNS_SEEK_SECS); unset = defaults. */
export function hnsEnvOptions(env: NodeJS.ProcessEnv = process.env): HnsModeOptions {
	const num = (v: string | undefined, min: number, max: number) => {
		const n = Number(v);
		return v !== undefined && v !== '' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : undefined;
	};
	const out: HnsModeOptions = {};
	const hide = num(env.HNS_HIDE_SECS, 5, 300);
	const seek = num(env.HNS_SEEK_SECS, 30, 1800);
	if (hide !== undefined) out.hideSecs = hide;
	if (seek !== undefined) out.seekSecs = seek;
	return out;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

function clock(secs: number): string {
	const t = Math.max(0, Math.round(secs));
	return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export class HnsMode implements ServerMode {
	readonly id = 'hns' as const;
	readonly game: HnsGame;
	/** Last over-cap state per player (ms). */
	private readonly overCap = new Map<number, number>();
	private lastSent = -Infinity;
	private readonly hunt: HuntTracker;
	private readonly chasing = new TimeMeter(HNS_PAY.seekerChase.everyMs);
	private readonly chased = new TimeMeter(HNS_PAY.hiderChased.everyMs);
	private readonly inView = new TimeMeter(HNS_PAY.plainView.everyMs);
	/** Where a hider in plain view stays (hider → centre of the small area). */
	private readonly viewAt = new Map<number, Vec3>();
	/** Time each hider was seen this round (ms). */
	private readonly seenMs = new Map<number, number>();
	/** Players who started this round as seekers and have not left it. */
	private readonly starters = new Set<number>();
	/** Finds this round, by anyone. */
	private finds = 0;
	/** Hiders whose touch of the bag was refused: they have to walk up to it again. */
	private readonly bagRefused = new Set<number>();
	/** Hiders told why the bag cannot be taken (once per round). */
	private readonly bagTold = new Set<number>();

	constructor(
		private readonly host: ModeHost,
		opts: HnsModeOptions = {}
	) {
		const map = host.map;
		const world = buildCollisionWorld(map);
		this.game = new HnsGame({
			...opts,
			map,
			now: host.now(),
			rng: () => host.rng(),
			los: (a, b) => world.trace(a, b, ZERO, ZERO).fraction >= 1,
			bagAllowed: () => host.economy.enoughPlayers('hnsBag')
		});
		this.hunt = new HuntTracker({ sight: buildSight(map), chaseRange: HUNT_RANGE.hnsChase, pursuit: true, viewRange: HUNT_RANGE.hnsView });
	}

	join(p: ModePlayer): void {
		this.tick();
		this.host.send(p, this.stateMessage());
		this.host.systemTo(
			p,
			'Hide and seek: hiders hide while the seekers are blindfolded; seekers then hunt them with knives (Mouse1). A found hider becomes a seeker. Hiders win if anyone is still hidden when time runs out.'
		);
		if (this.game.inRound) this.host.systemTo(p, 'A round is running: you join as a seeker.');
	}

	leave(p: ModePlayer): void {
		this.overCap.delete(p.id);
		this.starters.delete(p.id);
		this.tick();
	}

	spectate(p: ModePlayer): void {
		this.starters.delete(p.id);
		this.tick();
	}

	state(p: ModePlayer, s: NetState): void {
		const now = this.host.now();
		this.game.setPos(p.id, { x: s.x, y: s.y, z: s.z, ducked: (s.flags & FLAG_DUCKED) !== 0 }, now, (s.flags & FLAG_TELEPORTED) !== 0);
		if (overSpeedCap(s.vx, s.vy)) {
			const prev = this.overCap.get(p.id) ?? -Infinity;
			if (now - prev > 5000) this.host.log(`hns: #${p.id} ${p.name} over the ${HNS_SPEED_LIMIT} u/s limit (${Math.round(Math.hypot(s.vx, s.vy))})`);
			this.overCap.set(p.id, now);
		}
		this.tryBag(p.id, true);
	}

	zone(): void {}

	records(): MapRecordInfo {
		return { ...EMPTY_RECORDS };
	}

	message(p: ModePlayer, msg: ModeClientMessage): void {
		if (msg.type !== 'knife' || p.spectating || !this.game.has(p.id)) return;
		const now = this.host.now();
		if (now - (this.overCap.get(p.id) ?? -Infinity) < HNS_SPEED_PENALTY_MS) return;
		const rewind = renderRewindMs(msg.renderServerTimeMs, this.host.serverNow?.() ?? now, p, HNS_MAX_REWIND_MS, p.ping + HNS_VIEW_DELAY_MS);
		const res = this.game.swing(p.id, { origin: msg.origin, dir: msg.dir }, now, rewind);
		if (res.ok) this.hunt.attempt(p.id);
		this.dispatch(res.events);
	}

	command(p: ModePlayer, cmd: Command): boolean {
		if (cmd.cmd !== 'top' && cmd.cmd !== 'pb') return false;
		const g = this.game;
		this.host.systemTo(p, `No leaderboard in hide and seek. This round: ${g.finds(p.id)} finds, survived ${clock(g.survived(p.id))}.`);
		return true;
	}

	scoreRows(): ScoreRow[] {
		const g = this.game;
		const rows: ScoreRow[] = [];
		for (const p of this.host.players()) {
			const role = p.spectating ? null : g.role(p.id);
			rows.push({
				id: p.id,
				name: p.name,
				rank: null,
				pbTicks: null,
				status: !role ? Status.Spectating : role === 'seeker' ? Status.Seeker : Status.Hider,
				stage: 0,
				ping: Math.round(p.ping),
				spectating: p.spectating,
				kills: role ? g.finds(p.id) : 0,
				score: role ? g.survived(p.id) : 0
			});
		}
		rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.kills ?? 0) - (a.kills ?? 0) || a.name.localeCompare(b.name));
		return rows;
	}

	/** Frozen seekers are held; hiders sit still and look around, and seekers may guard the cash bag. */
	stillness(p: ModePlayer): 'held' | 'look' | null {
		const g = this.game;
		if (!g.inRound) return null;
		if (g.isFrozen(p.id, this.host.now())) return 'held';
		return g.role(p.id) ? 'look' : null;
	}

	tick(): void {
		const now = this.host.now();
		const active: number[] = [];
		for (const p of this.host.players()) if (!p.spectating) active.push(p.id);
		this.dispatch(this.game.update(now, active));
		if (this.game.phase === 'seeking') {
			this.payHunt(now);
			if (this.game.bagCoins !== null) for (const id of this.game.hiders) this.tryBag(id);
		}
		if (now - this.lastSent >= HNS_STATE_MS) {
			this.lastSent = now;
			this.host.broadcast(this.stateMessage());
		}
	}

	stateMessage(): Extract<ServerMessage, { type: 'modeState' }> {
		return { type: 'modeState', mode: 'hns', ...this.game.view(this.host.now()) };
	}

	// -----------------------------------------------------------------------
	// Coins

	private resetRound(): void {
		this.hunt.reset();
		this.chasing.reset();
		this.chased.reset();
		this.inView.reset();
		this.viewAt.clear();
		this.seenMs.clear();
		this.starters.clear();
		this.bagRefused.clear();
		this.bagTold.clear();
		this.finds = 0;
	}

	/** Chases, views and the abuse evidence of one sample. */
	private payHunt(now: number): void {
		const { game } = this;
		const { economy } = this.host;
		const seekers: HuntBody[] = [];
		const hiders: HuntBody[] = [];
		for (const p of this.host.players()) {
			const s = p.state;
			const role = game.role(p.id);
			if (!s || !role || p.spectating) continue;
			const body: HuntBody = { id: p.id, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, ducked: (s.flags & FLAG_DUCKED) !== 0 };
			if (role === 'hider') hiders.push(body);
			// A frozen seeker, or one who is not at the keyboard, sees nobody.
			else if (!game.isFrozen(p.id, now) && economy.isActive(p.id)) seekers.push(body);
		}
		const s = this.hunt.update(now, seekers, hiders);
		if (!s) return;
		for (const [id, e] of s.chasing) if (this.chasing.add(id, e.ms) > 0) economy.award(id, HNS_PAY.seekerChase.points, 'hnsChase', { against: e.by });
		for (const [id, e] of s.chased) if (this.chased.add(id, e.ms) > 0) economy.award(id, HNS_PAY.hiderChased.points, 'hnsChased', { against: e.by });
		for (const h of hiders) this.payView(h, s);
		for (const { hunter, target } of s.shadows) economy.report('shadow', [hunter, target], '20 s without a knife swing');
	}

	/** Time in view: towards "seen" for the whole round, towards plain view only in one small area and while not chased. */
	private payView(h: HuntBody, s: HuntSample): void {
		const e = s.seen.get(h.id);
		if (!e) return;
		this.seenMs.set(h.id, (this.seenMs.get(h.id) ?? 0) + e.ms);
		const at = this.viewAt.get(h.id);
		if (!at || Math.hypot(h.x - at.x, h.y - at.y, h.z - at.z) > HNS_PAY.plainView.area) {
			this.viewAt.set(h.id, { x: h.x, y: h.y, z: h.z });
			this.inView.reset(h.id);
		}
		if (s.chased.has(h.id)) return;
		if (this.inView.add(h.id, e.ms) > 0) this.host.economy.award(h.id, HNS_PAY.plainView.points, 'hnsView', { against: e.by });
	}

	/** A hider may be touching the cash bag (`swept`: on a new state packet, with the way since the last one). */
	private tryBag(id: number, swept = false): void {
		const { game } = this;
		const coins = game.bagCoins;
		if (coins === null || game.phase !== 'seeking') return;
		if (this.bagRefused.has(id)) {
			if (game.bagDistance(id) > HNS_BAG_RETRY_DIST) this.bagRefused.delete(id);
			return;
		}
		if (!game.reachesBag(id, swept)) return;
		const r = this.host.economy.award(id, coins * POINTS_SCALE, 'hnsBag');
		if (r.paid === 0) {
			switch (r.refused) {
				// They got there by playing: the bag is theirs, even if it pays nothing.
				case 'guest':
				case 'paused':
				case 'backstop':
				case 'cap':
					break;
				// An impossible speed or jump: no remote pickup, and no waiting next to the bag either.
				case 'suspect':
					this.bagRefused.add(id);
					return;
				case 'minPlayers': {
					const p = this.player(id);
					if (p && !this.bagTold.has(id)) this.host.systemTo(p, `The cash bag needs ${MIN_ACTIVE.hns} active players. It stays here for now.`);
					this.bagTold.add(id);
					return;
				}
				default:
					return;
			}
		}
		this.dispatch(game.takeBag(id, r.paid));
	}

	/** The round is over: survivals or the seekers' win. */
	private payEnd(winner: 'hiders' | 'seekers', survivors: number[]): void {
		const { economy } = this.host;
		if (winner === 'hiders') {
			for (const id of survivors)
				economy.award(id, (this.seenMs.get(id) ?? 0) >= HNS_PAY.seenMs ? HNS_PAY.surviveSeen : HNS_PAY.surviveUnseen, 'hnsSurvive');
		} else if (this.finds > 0) {
			// Not when the hiders only left the server.
			for (const id of this.starters) economy.award(id, HNS_PAY.seekersWin, 'hnsSeekersWin');
		}
		economy.roundEnd();
	}

	private player(id: number): ModePlayer | null {
		for (const p of this.host.players()) if (p.id === id) return p;
		return null;
	}

	private name(id: number): string {
		return this.player(id)?.name ?? `Player ${id}`;
	}

	private names(ids: number[]): string {
		return ids.map((id) => this.name(id)).join(' and ');
	}

	/** Send events to their audience and announce them in chat. */
	private dispatch(events: HnsEvent[]): void {
		const h = this.host;
		let changed = false;
		for (const ev of events) {
			switch (ev.e) {
				case 'spawn': {
					const p = this.player(ev.id);
					if (p) h.send(p, { type: 'hns', ev });
					continue;
				}
				case 'swing':
					h.broadcast({ type: 'hns', ev }, ev.by);
					continue;
			}
			changed = true;
			h.broadcast({ type: 'hns', ev });
			switch (ev.e) {
				case 'waiting':
					if (ev.cancelled) h.economy.roundEnd();
					if (ev.cancelled) h.system('Not enough players: round cancelled. Hide and seek needs 2+ players.');
					break;
				case 'starting':
					h.system(`Hide and seek starts in ${ev.secs} s.`);
					break;
				case 'roundStart': {
					this.resetRound();
					h.economy.roundStart();
					for (const id of ev.seekers) this.starters.add(id);
					const n = ev.seekers.length;
					h.system(`Round ${ev.round}: ${this.names(ev.seekers)} ${n > 1 ? 'are' : 'is'} seeking. Hiders, you have ${ev.hideSecs} s to hide!`);
					h.log(`hns round ${ev.round} seekers=${ev.seekers.join(',')}`);
					break;
				}
				case 'release':
					h.system(`Ready or not, here they come! Seekers released: ${clock(ev.seekSecs)} to find everyone.`);
					break;
				case 'found':
					this.finds++;
					h.economy.award(ev.by, HNS_PAY.find, 'hnsFind', { against: ev.target });
					h.economy.contact(ev.by, ev.target);
					h.system(`${this.name(ev.by)} found ${this.name(ev.target)}. ${ev.hidersLeft} hider${ev.hidersLeft === 1 ? '' : 's'} left.`);
					break;
				case 'newSeeker':
					h.system(`Every seeker left: ${this.name(ev.id)} is now seeking.`);
					break;
				case 'lastHider':
					h.system(`${this.name(ev.id)} is the last hider!`);
					break;
				case 'warn':
					h.system(`${ev.secs} seconds left!`);
					break;
				case 'bag':
					h.system(`A bag of cash appeared ${ev.place}! The first hider to touch it gets ${HNS_PAY.bagMin / POINTS_SCALE} to ${HNS_PAY.bagMax / POINTS_SCALE} coins.`);
					h.log(`hns round ${this.game.round} bag coins=${this.game.bagCoins}`);
					break;
				case 'bagTaken':
					h.system(`${this.name(ev.by)} grabbed the cash bag${ev.paid > 0 ? `: ${formatTenths(ev.paid)} coins!` : '.'}`);
					break;
				case 'end': {
					this.payEnd(ev.winner, ev.survivors);
					const top = ev.topSeeker ? ` Top seeker: ${this.name(ev.topSeeker.id)} (${ev.topSeeker.finds} found).` : '';
					h.system(
						ev.winner === 'hiders'
							? `Round ${ev.round}: hiders win! Survived: ${this.names(ev.survivors)}.${top}`
							: `Round ${ev.round}: seekers win, everyone was found.${top}`
					);
					if (this.game.bagCoins !== null) h.system('Nobody took the cash bag.');
					h.log(`hns round ${ev.round} end winner=${ev.winner}`);
					break;
				}
			}
		}
		if (changed) {
			this.lastSent = h.now();
			h.broadcast(this.stateMessage());
		}
	}

	dispose(): void {}
}
