/**
 * Zombie Defense gamemode, id `defense` (docs/modes.md#zombie-defense).
 * Server-authoritative: the shared `DefenseGame` (build and wave phases,
 * zombie AI on the real movement code, barricades, turrets, gold and the
 * shop, weapons with lag-compensated hits, player health) runs here on the
 * latest state packets. Clients send `fire`/`reload`/`zd` and display the
 * results: `modeState` (mode 'defense'), `zd` events and BIN_DEFENSE frames.
 */
import type { DefenseGameOptions, MapRecordInfo, NetState, ScoreRow, ServerMessage, ZdEvent } from '@surf/shared';
import {
	buildCollisionWorld,
	decayed,
	DEFENSE_PAY,
	DefenseGame,
	encodeDefense,
	FLAG_DUCKED,
	mapCvars,
	REPEAT_MS,
	Status,
	ZD_TURRETS,
	ZD_ZOMBIES,
	zdEventRoute
} from '@surf/shared';
import type { Command } from '../commands.ts';
import { parseZdInput } from './defense-input.ts';
import type { ModeClientMessage, ModeHost, ModePlayer, ServerMode } from './types.ts';
import { EMPTY_RECORDS } from './types.ts';

/** Mode state is re-sent at least this often (ms), and at most this often on changes. */
export const ZD_STATE_MS = 1000;
export const ZD_STATE_MIN_MS = 250;

export type DefenseModeOptions = Pick<
	DefenseGameOptions,
	'firstBuildSecs' | 'buildSecs' | 'endSecs' | 'waveMaxSecs' | 'maxZombies' | 'spawnIntervalScale' | 'startGold' | 'plan'
>;

const HELP =
	'Zombie Defense: hold the base against endless waves. Hold E at a broken barricade to board it up, E on a turret pad (build phase) to build, upgrade or sell a turret, B opens the shop (build phase). Keys 1-5 swap weapons, R reloads.';

function clock(secs: number): string {
	const m = Math.floor(secs / 60);
	const s = Math.round(secs - m * 60);
	return `${m}:${String(s).padStart(2, '0')}`;
}

export class DefenseMode implements ServerMode {
	readonly id = 'defense' as const;
	readonly game: DefenseGame;
	private lastSent = -Infinity;
	private dirty = true;

	constructor(
		private readonly host: ModeHost,
		opts: DefenseModeOptions = {}
	) {
		const map = host.map;
		this.game = new DefenseGame({
			...opts,
			map,
			world: buildCollisionWorld(map),
			cvars: mapCvars(map),
			now: host.now(),
			rng: () => host.rng(),
			lenient: true
		});
	}

	join(p: ModePlayer): void {
		this.tick();
		this.host.send(p, this.stateMessage());
		this.host.systemTo(p, HELP);
		if (this.game.phase === 'wave' || this.game.phase === 'ended') this.host.systemTo(p, 'You join the defence when the next build phase starts.');
	}

	leave(): void {
		this.tick();
	}

	spectate(): void {
		this.tick();
	}

	state(p: ModePlayer, s: NetState): void {
		this.game.setPlayerPos(p.id, { x: s.x, y: s.y, z: s.z, ducked: (s.flags & FLAG_DUCKED) !== 0, yaw: s.yaw });
	}

	zone(): void {}

	records(): MapRecordInfo {
		return { ...EMPTY_RECORDS };
	}

	/** fire / reload / zd from a player; malformed messages are dropped whole (defense-input.ts). */
	message(p: ModePlayer, msg: ModeClientMessage): void {
		if (p.spectating || !this.game.hasPlayer(p.id)) return;
		const input = parseZdInput(msg);
		if (!input) return;
		const now = this.host.now();
		switch (input.type) {
			case 'fire': {
				const res = this.game.fire(p.id, input, now);
				if (res.ok) this.host.economy.acted(p.id);
				this.dispatch(res.events);
				return;
			}
			case 'reload':
				this.game.reload(p.id, now);
				return;
			case 'zd':
				this.dispatch(this.game.act(p.id, input.act, now));
				if (input.act.a !== 'repair') this.dirty = true;
				return;
		}
	}

	command(p: ModePlayer, cmd: Command): boolean {
		if (cmd.cmd !== 'top' && cmd.cmd !== 'pb') return false;
		const v = this.game.playerView(p.id);
		this.host.systemTo(p, `No leaderboard in Zombie Defense yet. This game: wave ${this.game.wave}, ${v?.kills ?? 0} kills, ${v?.gold ?? 0} gold.`);
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
				status: p.spectating || !v ? Status.Spectating : v.status === 'alive' ? Status.Alive : v.status === 'dead' ? Status.Down : Status.Idle,
				stage: this.game.wave,
				ping: Math.round(p.ping),
				spectating: p.spectating,
				kills: v?.kills ?? 0,
				deaths: v?.deaths ?? 0,
				score: v?.gold ?? 0
			});
		}
		rows.sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0) || a.name.localeCompare(b.name));
		return rows;
	}

	/** Dead players and players waiting for the next build phase are held. */
	stillness(p: ModePlayer): 'held' | null {
		const v = this.game.playerView(p.id);
		return v && v.status !== 'alive' ? 'held' : null;
	}

	tick(): void {
		const now = this.host.now();
		const ids: number[] = [];
		for (const p of this.host.players()) if (!p.spectating) ids.push(p.id);
		this.game.syncPlayers(ids, now);
		this.dispatch(this.game.update(now));
		if ((this.dirty && now - this.lastSent >= ZD_STATE_MIN_MS) || now - this.lastSent >= ZD_STATE_MS) {
			this.lastSent = now;
			this.dirty = false;
			this.host.broadcast(this.stateMessage());
		}
		this.sendSnapshot();
	}

	/** BIN_DEFENSE snapshot (every mode tick; droppable under backlog like player snapshots). */
	sendSnapshot(): void {
		const g = this.game;
		if (g.zombies.size === 0 && g.phase !== 'wave') return;
		const s = g.snapshot();
		this.host.broadcastBinary(encodeDefense(s.tick, s.zombies, s.turrets), true);
	}

	stateMessage(): Extract<ServerMessage, { type: 'modeState' }> {
		return { type: 'modeState', mode: 'defense', ...this.game.view(this.host.now()) };
	}

	private name(id: number): string {
		for (const p of this.host.players()) if (p.id === id) return p.name;
		return `Player ${id}`;
	}

	private dispatch(events: ZdEvent[]): void {
		const h = this.host;
		for (const ev of events) {
			const route = zdEventRoute(ev);
			const msg: ServerMessage = { type: 'zd', ev };
			if (route.to !== undefined) {
				for (const p of h.players()) if (p.id === route.to) h.send(p, msg);
			} else if (route.except !== undefined) {
				for (const p of h.players()) if (p.id !== route.except) h.send(p, msg);
			} else h.broadcast(msg);
			this.announce(ev);
		}
	}

	// ---------------------------------------------------------------------
	// Coins (docs/economy.md#zombie-defense): one award per wave cleared, to
	// every player who was in the game for it. Each wave is a round of points.

	private payWave(wave: number, ids: readonly number[]): void {
		const e = this.host.economy;
		const label = `Wave ${wave}`;
		const key = `wave${wave}`;
		const present = new Set<number>();
		for (const p of this.host.players()) if (!p.spectating) present.add(p.id);
		for (const id of ids) {
			if (!present.has(id)) continue;
			// An account connected twice is paid once.
			if (e.tally(id, key, 'round') > 1) continue;
			const repeats = Math.max(e.tally(id, key, 'session') - 1, e.paidWithin(id, 'defenseWave', REPEAT_MS, label));
			e.award(id, decayed(DEFENSE_PAY.wave(wave), DEFENSE_PAY.repeat, repeats), 'defenseWave', { label });
		}
	}

	private announce(ev: ZdEvent): void {
		const h = this.host;
		const g = this.game;
		const openingName = (i: number) => g.info.openings[i]?.name ?? `opening ${i + 1}`;
		switch (ev.e) {
			case 'phase':
				this.dirty = true;
				if (ev.phase === 'wave') {
					h.economy.roundStart();
					const boss = g.waveSize > 0 && ev.wave % 5 === 0 ? ` A ${ZD_ZOMBIES.boss.label} is coming!` : '';
					h.system(`Wave ${ev.wave}: ${g.waveSize} zombies.${boss}`);
				} else if (ev.phase === 'build') {
					const secs = Math.round(g.view(h.now()).timeLeft);
					h.system(
						ev.wave === 1
							? `Game ${ev.round}: wave 1 in ${secs} s. Build turrets on the pads, buy in the shop (B), then press Ready.`
							: `Build phase: wave ${ev.wave} in ${secs} s.`
					);
				} else if (ev.phase === 'waiting') h.economy.roundEnd();
				break;
			case 'cleared':
				this.dirty = true;
				this.payWave(ev.wave, ev.ids);
				h.economy.roundEnd();
				h.system(`Wave ${ev.wave} cleared in ${clock(ev.secs)}. +${ev.bonus} gold for everyone.`);
				h.log(`defense wave ${ev.wave} cleared ${ev.secs}s players=${ev.ids.length}`);
				break;
			case 'timeout':
				h.system(`Wave ${ev.wave} ran too long: ${ev.removed} zombies gave up.`);
				break;
			case 'end': {
				this.dirty = true;
				h.economy.roundEnd();
				const top = ev.topId !== null ? ` Top killer: ${this.name(ev.topId)} (${ev.topKills}).` : '';
				h.system(`Overrun at wave ${ev.wave} after ${clock(ev.secs)}: ${ev.kills} zombies killed.${top} A new game starts shortly.`);
				h.log(`defense game ${ev.round} lost at wave ${ev.wave} ${ev.secs}s kills=${ev.kills}`);
				break;
			}
			case 'death':
				this.dirty = true;
				h.system(`${this.name(ev.id)} died. They respawn at the next build phase if the others hold out.`);
				break;
			case 'breach':
				this.dirty = true;
				h.system(`The ${openingName(ev.opening)} is broken through!`);
				break;
			case 'boss':
				h.system(`The ${ZD_ZOMBIES.boss.label} is here. It smashes barricades in one go.`);
				break;
			case 'turret':
				this.dirty = true;
				if (ev.op !== 'sell' && ev.type) h.system(`${this.name(ev.by)} ${ev.op === 'build' ? 'built' : 'upgraded'} a ${ZD_TURRETS[ev.type].label} (level ${ev.level}).`);
				break;
			case 'plank':
			case 'hurt':
			case 'heal':
			case 'kill':
			case 'ready':
			case 'spawn':
			case 'result':
				this.dirty = true;
				break;
		}
	}

	dispose(): void {}
}
