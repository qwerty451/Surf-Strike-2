/**
 * Infected gamemode (docs/modes.md#infected). Server-authoritative: the shared
 * `InfectedGame` (round flow, teams, limited ammo, lag-compensated hits,
 * throwing-knife projectiles, UAV pulses) runs here on the latest state
 * packets; clients send `fire`/`reload`/`loadout`/`throwKnife`/`placeBeacon`/`callMoab`
 * (checked in infected-input.ts) and display the results.
 */
import type { InfEvent, InfPerkId, InfPhase, MapRecordInfo, NetState, ScoreRow, ServerMessage, WeaponId } from '@surf/shared';
import {
	buildCollisionWorld,
	decayed,
	FLAG_DUCKED,
	FLAG_ON_GROUND,
	FLAG_TELEPORTED,
	INF_PERK_KILLS,
	INF_ROUND_SECS,
	INF_SECONDARY,
	INF_STEP_MS,
	INF_UAV_INTERVAL_MS,
	InfectedGame,
	INFECTED_PAY,
	infEventRoute,
	INF_HISTORY_MS,
	infRewindMs,
	Status,
	WEAPONS,
	type InfectedGameOptions
} from '@surf/shared';
import type { Command } from '../commands.ts';
import { clampFireTick, parseInfInput } from './infected-input.ts';
import type { ModeClientMessage, ModeHost, ModePlayer, ServerMode } from './types.ts';
import { EMPTY_RECORDS, renderRewindMs } from './types.ts';

/** Mode state is re-sent at least this often (ms), and at most this often on minor changes. */
export const INF_STATE_MS = 1000;
export const INF_STATE_MIN_MS = 250;
/** Grace countdown chat lines at these remaining seconds. */
const GRACE_COUNTDOWN = new Set([5, 3, 2, 1]);

export type InfectedModeOptions = Pick<
	InfectedGameOptions,
	'graceSecs' | 'roundSecs' | 'endSecs' | 'respawnSecs' | 'minPlayers' | 'moabKills' | 'moabCountdownSecs'
>;

/** Events that change what everyone sees right away: state goes out immediately. */
const URGENT = new Set<InfEvent['e']>([
	'phase',
	'alpha',
	'infect',
	'end',
	'knifeThrow',
	'knifeBounce',
	'knifeStick',
	'knifePickup',
	'knifeRemove',
	'beaconPlace',
	'beaconDestroy',
	'beaconUse',
	'perk',
	'moabReady',
	'moabCall',
	'moabDetonate'
]);

const PERK_NAMES: Readonly<Record<InfPerkId, string>> = {
	hardline: 'Hardline',
	sleight: 'Sleight of Hand (faster reloads)',
	scavenger: 'Scavenger (full ammo refills from kills, pistol too)',
	steady: 'Steady Aim (tighter spread, faster movement)',
	specialist: 'Specialist Bonus (faster fire, harder knockback, 6 HP)'
};

const weaponName = (w: WeaponId) => WEAPONS[w].label.toLowerCase();

function clock(secs: number): string {
	const m = Math.floor(secs / 60);
	const s = secs - m * 60;
	return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export class InfectedMode implements ServerMode {
	readonly id = 'infected' as const;
	readonly game: InfectedGame;
	private lastSent = -Infinity;
	private dirty = true;
	private urgent = false;
	/** Last grace countdown second announced (per round). */
	private graceSaid = -1;
	/** Last survivor already announced this round. */
	private lastSurvivorSaid: number | null = null;
	/** Active player ids of the last tick (a roster change re-sends state at once). */
	private roster = '';
	/** Phase of the last `phase` event (a drop to waiting only says "cancelled" mid-round). */
	private phaseSaid: InfPhase = 'waiting';
	/** Coins: normal length of the playing phase (ms) and when the running one started. */
	private readonly clockMs: number;
	private playingSince: number | null = null;
	/** Coins: survivors when the round began, and how many were infected by someone. */
	private firstSurvivors = 0;
	private infected = 0;
	/** Coins: infections the lobby can still be paid for (`INFECTED_PAY.infectStock`). */
	private stock: number = INFECTED_PAY.infectStock.max;
	private stockAt: number | null = null;
	/** Coins: infected killed in the current survivor life, by survivor id. */
	private readonly streakVictims = new Map<number, Set<string>>();
	/** PlayerId of whoever called the M.O.A.B. (the id may be someone else's by now). */
	private moabCaller: string | null = null;

	constructor(
		private readonly host: ModeHost,
		opts: InfectedModeOptions = {}
	) {
		const map = host.map;
		this.clockMs = (opts.roundSecs ?? INF_ROUND_SECS) * 1000;
		this.game = new InfectedGame({
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
			'Infected: during the grace period everyone spreads out, then one player becomes Patient Zero. ' +
				'Survivors hold out until the clock runs out (each infection adds 20 s); infected have no guns, only claws and a right-click throwing knife that bounces once and can be picked up again. ' +
				'Infected can press [E] to drop a Respawn Beacon on the ground below them: their next respawn is on it, unless a survivor shoots or knifes it first. ' +
				'Survivors: 1-3 switches primary/pistol/knife, R reloads. Kill streaks unlock perks (1, 3, 5, 7 kills); a long enough streak earns a M.O.A.B., press [N] to call it.'
		);
		if (this.game.phase === 'waiting') this.host.systemTo(p, 'Waiting for more players: Infected needs 2+ to start a round.');
	}

	leave(p: ModePlayer): void {
		this.streakVictims.delete(p.id);
		this.tick();
	}

	spectate(p: ModePlayer): void {
		this.streakVictims.delete(p.id);
		this.tick();
	}

	state(p: ModePlayer, s: NetState): void {
		// The view and the motion too: the hit body leans, runs, jumps and aims as the drawn one does.
		this.game.setPlayerPos(
			p.id,
			{
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
			},
			(s.flags & FLAG_TELEPORTED) !== 0
		);
	}

	zone(): void {}

	records(): MapRecordInfo {
		return { ...EMPTY_RECORDS };
	}

	/** fire / reload / loadout (weapon switch) / throwKnife / placeBeacon / callMoab from a player. */
	message(p: ModePlayer, msg: ModeClientMessage): void {
		if (p.spectating || !this.game.hasPlayer(p.id)) return;
		const input = parseInfInput(msg);
		if (!input) return;
		const now = this.host.now();
		switch (input.type) {
			case 'fire': {
				const { weapon, origin, dir } = input;
				const fallback = infRewindMs(p.ping);
				const legacy = input.tick === null ? fallback : (this.game.tick - clampFireTick(input.tick, this.game.tick, fallback)) * INF_STEP_MS;
				const rewindMs = renderRewindMs(input.renderServerTimeMs, this.host.serverNow?.() ?? now, p, INF_HISTORY_MS, legacy);
				const res = this.game.fire(p.id, { weapon, origin, dir, tick: this.game.tick, rewindMs }, now);
				// Holding an angle and shooting is playing (docs/economy.md): a real shot of a gun, not a swing.
				if (res.ok && this.game.phase === 'playing' && WEAPONS[weapon].magazine > 0) this.host.economy.acted(p.id);
				this.dispatch(res.events);
				break;
			}
			case 'reload':
				// A reload that starts is heard by the other players (`reload` event, not sent to the reloader).
				if (this.game.reload(p.id, now)) this.dispatch(this.game.takeEvents());
				return;
			case 'loadout':
				this.dispatch(this.game.selectWeapon(p.id, input.weapon, now));
				this.dirty = true;
				break;
			case 'throwKnife': {
				// Rewind the immediate spawn segment. Subsequent flight uses current poses.
				const rewind = renderRewindMs(input.renderServerTimeMs, this.host.serverNow?.() ?? now, p, INF_HISTORY_MS, 0);
				const res = this.game.throwKnife(p.id, input.origin, input.dir, now, rewind);
				this.dispatch(res.events);
				break;
			}
			case 'placeBeacon': {
				const res = this.game.placeBeacon(p.id, now);
				if (!res.ok && (res.reason === 'no ground' || res.reason === 'blocked')) this.host.systemTo(p, 'No room for a Respawn Beacon here: stand or jump over flat, open ground.');
				this.dispatch(res.events);
				break;
			}
			case 'callMoab': {
				const res = this.game.callMoab(p.id, now);
				this.dispatch(res.events);
				break;
			}
		}
		this.flushState(now);
	}

	command(p: ModePlayer, cmd: Command): boolean {
		if (cmd.cmd !== 'top' && cmd.cmd !== 'pb') return false;
		const v = this.game.playerView(p.id);
		this.host.systemTo(
			p,
			`No leaderboard in infected. This round: ${v?.score ?? 0} points, ${v?.kills ?? 0} kills, ${v?.deaths ?? 0} deaths.`
		);
		return true;
	}

	scoreRows(): ScoreRow[] {
		const rows: ScoreRow[] = [];
		for (const p of this.host.players()) {
			const v = p.spectating ? null : this.game.playerView(p.id);
			rows.push({
				id: p.id,
				name: p.name,
				rank: null,
				pbTicks: null,
				status: !v ? Status.Spectating : v.alpha ? Status.Alpha : v.team === 'infected' ? Status.Infected : Status.Alive,
				stage: 0,
				ping: Math.round(p.ping),
				spectating: p.spectating,
				score: v?.score ?? 0,
				kills: v?.kills ?? 0,
				deaths: v?.deaths ?? 0
			});
		}
		rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.kills ?? 0) - (a.kills ?? 0) || a.name.localeCompare(b.name));
		return rows;
	}

	/** Dead players wait for their respawn. */
	stillness(p: ModePlayer): 'held' | null {
		const v = this.game.playerView(p.id);
		return v && !v.alive ? 'held' : null;
	}

	tick(): void {
		const now = this.host.now();
		const ids: number[] = [];
		// Stable identities: a rejoin (spectate toggle or reconnect) gets its round stats
		// back, and an id the lobby hands to someone else starts fresh.
		const keys = new Map<number, string>();
		for (const p of this.host.players()) {
			if (p.spectating) continue;
			ids.push(p.id);
			keys.set(p.id, p.playerId);
		}
		this.game.syncPlayers(ids, now, keys);
		const roster = ids.sort((a, b) => a - b).join(',');
		if (roster !== this.roster) {
			this.roster = roster;
			this.urgent = true;
		}
		this.dispatch(this.game.update(now));
		this.graceCountdown(now);
		this.lastSurvivorAlert(now);
		this.flushState(now);
	}

	stateMessage(): Extract<ServerMessage, { type: 'modeState' }> {
		return { type: 'modeState', mode: 'infected', ...this.game.view(this.host.now()) };
	}

	private flushState(now: number): void {
		if (this.urgent || (this.dirty && now - this.lastSent >= INF_STATE_MIN_MS) || now - this.lastSent >= INF_STATE_MS) {
			this.lastSent = now;
			this.dirty = false;
			this.urgent = false;
			this.host.broadcast(this.stateMessage());
		}
	}

	private name(id: number | null): string {
		for (const p of this.host.players()) if (p.id === id) return p.name;
		return `Player ${id}`;
	}

	private dispatch(events: InfEvent[]): void {
		const h = this.host;
		for (const ev of events) {
			const route = infEventRoute(ev);
			const msg: ServerMessage = { type: 'inf', ev };
			if (route.to !== undefined) {
				for (const p of h.players()) if (p.id === route.to) h.send(p, msg);
			} else if (route.except !== undefined) {
				h.broadcast(msg, route.except);
			} else h.broadcast(msg);
			if (URGENT.has(ev.e)) this.urgent = true;
			// A shot and a reload change nothing the mode state shows.
			else if (ev.e !== 'shot' && ev.e !== 'reload') this.dirty = true;
			this.announce(ev);
			this.pay(ev);
		}
	}

	private player(id: number): ModePlayer | null {
		for (const p of this.host.players()) if (p.id === id) return p;
		return null;
	}

	/** Same person across reconnects and double connections. */
	private person(id: number): string {
		const p = this.player(id);
		return !p ? `#${id}` : p.accountId !== null ? `a${p.accountId}` : `g${p.playerId}`;
	}

	/** Coins of a rules event (docs/economy.md#infected). M.O.A.B. victims have no `kill` event. */
	private pay(ev: InfEvent): void {
		const eco = this.host.economy;
		switch (ev.e) {
			case 'phase':
				if (ev.phase === 'playing') {
					eco.roundStart();
					this.playingSince = this.stockAt = this.host.now();
					this.firstSurvivors = this.game.view(this.host.now()).survivors; // Patient Zero is picked already
					this.infected = 0;
					this.streakVictims.clear();
					this.moabCaller = null;
				} else if (ev.phase === 'waiting') {
					// Cancelled: what was earned stays, nothing for surviving or winning.
					this.refillStock();
					this.playingSince = this.stockAt = null;
					eco.roundEnd();
				}
				break;
			case 'alpha':
				eco.tally(ev.id, 'zero', 'round');
				this.streakVictims.delete(ev.id);
				break;
			case 'kill':
				this.payKill(ev.by, ev.targetId);
				break;
			case 'infect':
				this.streakVictims.delete(ev.id);
				if (ev.by !== null) this.payInfection(ev.by, ev.id, ev.method === 'bank');
				break;
			case 'beaconDestroy':
				if (ev.by !== null && this.person(ev.by) !== this.person(ev.ownerId)) eco.award(ev.by, INFECTED_PAY.beacon, 'infBeacon', { against: ev.ownerId });
				break;
			case 'moabCall':
				this.moabCaller = this.player(ev.by)?.playerId ?? null;
				break;
			case 'moabDetonate':
				for (const p of this.host.players()) {
					if (p.playerId !== this.moabCaller) continue;
					eco.award(p.id, decayed(INFECTED_PAY.moab, INFECTED_PAY.moabRepeat, eco.tally(p.id, 'moab', 'session') - 1), 'infMoab');
				}
				this.moabCaller = null;
				break;
			case 'end':
				this.payEnd(ev.winner);
				eco.roundEnd();
				this.refillStock();
				this.playingSince = this.stockAt = null;
				break;
		}
	}

	private payKill(by: number, target: number): void {
		const eco = this.host.economy;
		const P = INFECTED_PAY;
		const victim = this.person(target);
		eco.contact(by, target);
		eco.tally(by, 'fought', 'round');
		if (eco.tally(by, `kill:${victim}`, 'round') <= P.kills.perVictim && eco.tally(by, 'kills', 'round') % P.kills.every === 0)
			eco.award(by, P.kills.points, 'infKills', { against: target });
		const victims = this.streakVictims.get(by) ?? new Set();
		this.streakVictims.set(by, victims.add(victim));
		if ((this.game.playerView(by)?.streak ?? 0) >= INF_PERK_KILLS.specialist && victims.size >= P.specialistVictims)
			eco.award(by, P.specialist, 'infSpecialist');
	}

	private refillStock(): void {
		if (this.stockAt === null) return;
		const { max, everyMs } = INFECTED_PAY.infectStock;
		const now = this.host.now();
		this.stock = Math.min(max, this.stock + (now - this.stockAt) / everyMs);
		this.stockAt = now;
	}

	private payInfection(by: number, target: number, bank: boolean): void {
		const eco = this.host.economy;
		this.infected++;
		eco.contact(by, target);
		eco.tally(by, 'infected', 'round');
		this.refillStock();
		if (this.stock < 1) return;
		if (eco.award(by, INFECTED_PAY.infect, 'infInfect', { against: target }).paid > 0) this.stock--;
		if (bank) eco.award(by, INFECTED_PAY.bankShot, 'infBank', { against: target });
	}

	/** Round end: the winners of it. A survivor who turned counts as infected from then on. */
	private payEnd(winner: 'survivors' | 'infected'): void {
		const eco = this.host.economy;
		const P = INFECTED_PAY;
		const played = this.playingSince === null ? 0 : this.host.now() - this.playingSince;
		const players = this.game.view(this.host.now()).players;
		if (winner === 'infected') {
			if (played < this.clockMs * P.winShare) return;
			for (const p of players) {
				if (p.team !== 'infected') continue;
				if (eco.tallied(p.id, 'zero', 'round') > 0) eco.award(p.id, P.winPatientZero, 'infWin');
				else if (eco.tallied(p.id, 'infected', 'round') > 0) eco.award(p.id, P.winInfected, 'infWin');
			}
			return;
		}
		if (played < this.clockMs * P.surviveShare) return;
		const left = players.filter((p) => p.team === 'survivor' && p.alive);
		const hard = this.infected * 2 >= this.firstSurvivors;
		for (const p of left) {
			const full = hard && eco.tallied(p.id, 'fought', 'round') > 0;
			eco.award(p.id, full ? P.survive : P.surviveEasy, 'infSurvive');
			if (full && left.length === 1) eco.award(p.id, P.lastSurvivor, 'infLast');
		}
	}

	private graceCountdown(now: number): void {
		const g = this.game;
		if (g.phase !== 'grace') return;
		const secs = Math.ceil((g.endsAt - now) / 1000);
		if (secs === this.graceSaid || !GRACE_COUNTDOWN.has(secs)) return;
		this.graceSaid = secs;
		this.host.system(`Patient Zero is picked in ${secs}...`);
	}

	/** One survivor left against 2+ infected: announced once per survivor per round. */
	private lastSurvivorAlert(now: number): void {
		const g = this.game;
		if (g.phase !== 'playing') return;
		const v = g.view(now);
		if (v.survivors !== 1 || v.infected < 2) return;
		const last = v.players.find((p) => p.team === 'survivor' && p.alive);
		if (!last || last.id === this.lastSurvivorSaid) return;
		this.lastSurvivorSaid = last.id;
		this.host.system(
			`${this.name(last.id)} is the LAST SURVIVOR! A UAV reveals their position every ${INF_UAV_INTERVAL_MS / 1000} s. Hunt them down!`
		);
	}

	private announce(ev: InfEvent): void {
		const h = this.host;
		const g = this.game;
		switch (ev.e) {
			case 'phase': {
				const was = this.phaseSaid;
				this.phaseSaid = ev.phase;
				this.graceSaid = -1;
				this.lastSurvivorSaid = null;
				if (ev.phase === 'waiting')
					h.system(
						was === 'grace' || was === 'playing'
							? 'Not enough players: round cancelled. Infected needs 2+ players.'
							: 'Not enough players: waiting for 2+ to start the next round.'
					);
				else if (ev.phase === 'grace')
					h.system(
						`Round ${ev.round}: ${Math.round(g.view(h.now()).timeLeft)} s grace period, spread out! Loadout: ${weaponName(ev.loadout)} + ${weaponName(INF_SECONDARY)} + knife (1-3 to switch).`
					);
				else if (ev.phase === 'playing') h.log(`infected round ${ev.round} start`);
				break;
			}
			case 'alpha':
				h.system(`${this.name(ev.id)} is Patient Zero! Survive!`);
				h.log(`infected round ${g.round} alpha=${ev.id}`);
				break;
			case 'infect': {
				const victim = this.name(ev.id);
				const bonus = ev.timeAdded > 0 ? ` +${ev.timeAdded} s` : '';
				if (ev.by === null) h.system(`${victim} turned: the infected need a host.`);
				else if (ev.method === 'bank')
					h.system(`BANK SHOT! ${this.name(ev.by)} infected ${victim} with a throwing knife off the wall!${bonus}`);
				else if (ev.method === 'knife') h.system(`${this.name(ev.by)} infected ${victim} with a throwing knife!${bonus}`);
				else h.system(`${this.name(ev.by)} infected ${victim}!${bonus}`);
				break;
			}
			case 'perk': {
				if (ev.perk === 'specialist') h.system(`${this.name(ev.id)} earned the Specialist Bonus with a ${ev.streak}-kill streak!`);
				else for (const o of h.players()) if (o.id === ev.id) h.systemTo(o, `${ev.streak}-kill streak: ${PERK_NAMES[ev.perk]} unlocked.`);
				break;
			}
			case 'moabReady':
				for (const o of h.players()) if (o.id === ev.id) h.systemTo(o, 'M.O.A.B. ready! Press [N] to call it in.');
				break;
			case 'moabCall':
				h.system(`M.O.A.B. INBOUND! Detonating in ${ev.secs} s! Called in by ${this.name(ev.by)}.`);
				h.log(`infected round ${g.round} moab called by ${ev.by}`);
				break;
			case 'moabDetonate':
				h.system(`M.O.A.B. detonated! ${this.name(ev.by)} wiped out ${ev.kills} infected.`);
				h.log(`infected round ${g.round} moab detonated by ${ev.by} kills=${ev.kills}`);
				break;
			case 'beaconDestroy': {
				// Only the owner hears about it (chat stays uncluttered); clean-ups stay silent.
				if (ev.by === null) break;
				for (const o of h.players()) {
					if (o.id === ev.ownerId) h.systemTo(o, `${this.name(ev.by)} destroyed your Respawn Beacon.`);
				}
				break;
			}
			case 'end': {
				const top = ev.topId !== null ? ` Top player: ${this.name(ev.topId)} (${ev.topScore}).` : '';
				h.system(
					ev.winner === 'survivors'
						? `Survivors win round ${ev.round}! ${ev.survivorsLeft} held out for ${clock(ev.secs)}.${top}`
						: `Infected win round ${ev.round}: everyone turned after ${clock(ev.secs)}.${top}`
				);
				h.log(`infected round ${ev.round} ${ev.winner} ${ev.secs}s left=${ev.survivorsLeft}`);
				break;
			}
		}
	}

	dispose(): void {}
}
