/**
 * Infected mode on a fake host for server tests: no sockets, a clock the test
 * sets, and an inbox per player. Not a test file itself.
 */
import type { InfEvent, MapDef, NetState, ServerMessage, Spawn } from '@surf/shared';
import { FLAG_DUCKED, FLAG_ON_GROUND, Status } from '@surf/shared';
import type { Db } from './db.ts';
import type { ModeEconomy } from './economy.ts';
import { InfectedMode, type InfectedModeOptions } from './modes/infected.ts';
import type { ModeClientMessage, ModeHost } from './modes/types.ts';
import { netState, testMap } from './test-helpers.ts';

export const HOST_SPAWNS: Spawn[] = [
	{ pos: { x: -1500, y: -1500, z: 0.25 }, yaw: 45 },
	{ pos: { x: 1500, y: -1500, z: 0.25 }, yaw: 135 },
	{ pos: { x: -1500, y: 1500, z: 0.25 }, yaw: -45 },
	{ pos: { x: 1500, y: 1500, z: 0.25 }, yaw: 180 },
	{ pos: { x: 0, y: -1500, z: 0.25 }, yaw: 90 }
];

/** An open floor (top at z 0) with spawns near the corners and a fall-out box far below. */
export function openInfectedMap(): MapDef {
	return {
		...testMap('inf_open', 'Infected Open'),
		kind: 'infected',
		layout: 'open',
		cvars: {},
		spawn: HOST_SPAWNS[0]!,
		spawns: HOST_SPAWNS,
		brushes: [{ type: 'box', min: { x: -2000, y: -2000, z: -64 }, max: { x: 2000, y: 2000, z: 0 }, material: 'm' }],
		zones: [{ type: 'teleport', min: { x: -5000, y: -5000, z: -3000 }, max: { x: 5000, y: 5000, z: -500 }, to: 'start' }]
	};
}

export interface FakePlayer {
	id: number;
	playerId: string;
	accountId: number | null;
	name: string;
	spectating: boolean;
	state: NetState | null;
	ping: number;
	inbox: ServerMessage[];
}

export type Ev<K extends InfEvent['e']> = Extract<InfEvent, { e: K }>;

export interface PosePatch {
	z?: number;
	yaw?: number;
	ducked?: boolean;
}

/** An economy that pays nobody and counts nothing; `acted` gets the players who did something that counts as moving. */
function noEconomy(acted: number[]): ModeEconomy {
	return {
		award: () => ({ paid: 0 }) as ReturnType<ModeEconomy['award']>,
		activePlayers: () => 0,
		isActive: () => true,
		multiplier: () => 10,
		enoughPlayers: () => false,
		roundStart: () => {},
		roundEnd: () => {},
		tally: () => 1,
		tallied: () => 0,
		earned: () => 0,
		sinceLastPaid: () => null,
		paidWithin: () => 0,
		contact: () => {},
		report: () => {},
		teleported: () => {},
		acted: (id) => void acted.push(id)
	};
}

/** An InfectedMode with players `names` (ids 1..n), stepped to the playing phase: player 1 is Patient Zero (rng 0). */
export function infectedHost(names: string[], opts: InfectedModeOptions = {}) {
	let clock = 5_000_000;
	const players: FakePlayer[] = [];
	const logs: string[] = [];
	const chat: string[] = [];
	const acted: number[] = [];
	const host: ModeHost = {
		map: openInfectedMap(),
		db: null as unknown as Db,
		economy: noEconomy(acted),
		now: () => clock,
		rng: () => 0,
		players: () => players,
		send: (p, msg) => void players.find((o) => o.id === p.id)?.inbox.push(msg),
		broadcast: (msg, exceptId) => {
			for (const p of players) if (p.id !== exceptId) p.inbox.push(msg);
		},
		sendBinary: () => {},
		broadcastBinary: () => {},
		system: (text) => void chat.push(text),
		systemTo: () => {},
		guestRunNotice: () => {},
		log: (msg) => void logs.push(msg)
	};
	const mode = new InfectedMode(host, { graceSecs: 1, roundSecs: 600, endSecs: 1, ...opts });
	const h = {
		mode,
		game: mode.game,
		players,
		logs,
		chat,
		acted,
		get now() {
			return clock;
		},
		set now(t: number) {
			clock = t;
		},
		join(name: string): FakePlayer {
			const id = players.length + 1;
			const p: FakePlayer = { id, playerId: `player-${id}`, accountId: null, name, spectating: false, state: null, ping: 0, inbox: [] };
			players.push(p);
			mode.join(p);
			return p;
		},
		/** A state packet from `p` (feet position). */
		state(p: FakePlayer, x: number, y: number, patch: PosePatch = {}): void {
			const s = netState(0, x, { y, z: patch.z ?? 0, yaw: patch.yaw ?? 0, flags: FLAG_ON_GROUND | (patch.ducked ? FLAG_DUCKED : 0), status: Status.Alive });
			p.state = s;
			mode.state(p, s);
		},
		send(p: FakePlayer, msg: unknown): void {
			mode.message(p, msg as ModeClientMessage);
		},
		/** Mode ticks at 32 Hz for `ms` of fake time. */
		run(ms: number): void {
			for (let t = 0; t < ms; t += 1000 / 32) {
				clock += 1000 / 32;
				mode.tick();
			}
		},
		/** Infected events `p` received, from inbox index `from`. */
		events<K extends InfEvent['e']>(p: FakePlayer, e: K, from = 0): Ev<K>[] {
			const out: Ev<K>[] = [];
			for (const m of p.inbox.slice(from)) if (m.type === 'inf' && m.ev.e === e) out.push(m.ev as Ev<K>);
			return out;
		}
	};
	for (const n of names) h.join(n);
	for (let i = 0; i < 64 && mode.game.phase !== 'playing'; i++) h.run(1000 / 32);
	if (mode.game.phase !== 'playing' || mode.game.alphaId !== 1) throw new Error('infectedHost: not playing with player 1 as Patient Zero');
	return h;
}
