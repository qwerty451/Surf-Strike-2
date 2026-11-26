/** Shared helpers for server tests (node --test). Not a test file itself. */
import { WebSocket } from 'ws';
import type { DefenseFrame, GhostFrame, MapDef, NetState, ServerMessage, SnapshotEntry, SnapshotFrame, ZombieFrame } from '@surf/shared';
import { BIN_DEFENSE, BIN_ZOMBIES, decodeDefense, decodeGhostFrame, decodeSnapshot, decodeZombies, encodeState, PROTOCOL_VERSION, Status } from '@surf/shared';

/** Staged corridor along +X: start [0,200], stage 2 [1000,1100], end [2000,2100]. */
export function testMap(id = 'surf_test', title = 'Test'): MapDef {
	return {
		id,
		title,
		kind: 'surf',
		difficulty: 'easy',
		layout: 'staged',
		cvars: { sv_maxvelocity: 3500 },
		spawn: { pos: { x: 100, y: 0, z: 0 }, yaw: 0 },
		brushes: [],
		zones: [
			{ type: 'start', min: { x: 0, y: -100, z: 0 }, max: { x: 200, y: 100, z: 100 } },
			{
				type: 'stage',
				index: 2,
				min: { x: 1000, y: -100, z: 0 },
				max: { x: 1100, y: 100, z: 100 },
				respawn: { pos: { x: 1050, y: 0, z: 0 }, yaw: 0 }
			},
			{ type: 'end', min: { x: 2000, y: -100, z: 0 }, max: { x: 2100, y: 100, z: 100 } },
			{ type: 'teleport', min: { x: -5000, y: -5000, z: -1000 }, max: { x: 5000, y: 5000, z: -100 }, to: 'stage' }
		],
		theme: {
			skyTop: 0,
			skyHorizon: 0,
			skyBottom: 0,
			fogColor: 0,
			fogNear: 0,
			fogFar: 1,
			sunColor: 0,
			sunIntensity: 1,
			sunDir: { x: 0, y: 0, z: 1 },
			ambientSky: 0,
			ambientGround: 0,
			ambientIntensity: 1,
			materials: {},
			effects: []
		}
	};
}

export function netState(tick: number, x: number, extra: Partial<NetState> = {}): NetState {
	return {
		tick,
		x,
		y: 0,
		z: 0,
		vx: 0,
		vy: 0,
		vz: 0,
		pitch: 0,
		yaw: 0,
		flags: 0,
		status: Status.Running,
		stage: 1,
		runTicks: 0,
		...extra
	};
}

export class TestClient {
	readonly ws: WebSocket;
	readonly messages: ServerMessage[] = [];
	readonly snapshots: SnapshotEntry[][] = [];
	readonly snapshotFrames: SnapshotFrame[] = [];
	/** BIN_GHOST frames received. */
	readonly ghosts: GhostFrame[] = [];
	/** BIN_ZOMBIES frames received (zombies maps). */
	readonly zombieFrames: ZombieFrame[] = [];
	/** BIN_DEFENSE frames received (Zombie Defense maps). */
	readonly defenseFrames: DefenseFrame[] = [];
	closed = false;
	closeCode = 0;
	private spawnSeq = 0;
	private waiters: Array<() => void> = [];

	constructor(port: number, headers?: Record<string, string>, protocols: string[] = []) {
		this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, headers ? { headers } : undefined);
		this.ws.binaryType = 'arraybuffer';
		this.ws.on('message', (data, isBinary) => {
			if (isBinary && new Uint8Array(data as ArrayBuffer)[0] === BIN_ZOMBIES) {
				const zf = decodeZombies(data as ArrayBuffer);
				if (zf) this.zombieFrames.push(zf);
			} else if (isBinary && new Uint8Array(data as ArrayBuffer)[0] === BIN_DEFENSE) {
				const df = decodeDefense(data as ArrayBuffer);
				if (df) this.defenseFrames.push(df);
			} else if (isBinary) {
				const snap = decodeSnapshot(data as ArrayBuffer);
				if (snap) {
					this.snapshotFrames.push(snap);
					this.snapshots.push(snap.entries);
				}
				const ghost = snap ? null : decodeGhostFrame(data as ArrayBuffer);
				if (ghost) this.ghosts.push(ghost);
			} else {
				const message = JSON.parse(Buffer.from(data as ArrayBuffer).toString('utf8')) as ServerMessage;
				if ((message.type === 'hns' || message.type === 'inf' || message.type === 'zm' || message.type === 'zd' || message.type === 'trn') && message.spawnSeq !== undefined) this.spawnSeq = message.spawnSeq;
				this.messages.push(message);
			}
			this.notify();
		});
		this.ws.on('close', (code) => {
			this.closed = true;
			this.closeCode = code;
			this.notify();
		});
	}

	private notify(): void {
		const w = this.waiters;
		this.waiters = [];
		for (const f of w) f();
	}

	open(): Promise<void> {
		if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
		return new Promise((ok, fail) => {
			this.ws.once('open', () => ok());
			this.ws.once('error', fail);
		});
	}

	send(msg: unknown): void {
		this.ws.send(JSON.stringify(msg));
	}

	sendState(s: NetState): void {
		this.ws.send(encodeState({ ...s, spawnSeq: s.spawnSeq ?? this.spawnSeq }));
	}

	/** Wait until `pred` holds (checked on every incoming frame). */
	async until<T>(pred: () => T | undefined | null | false, ms = 2000): Promise<T> {
		const deadline = Date.now() + ms;
		for (;;) {
			const v = pred();
			if (v) return v;
			if (Date.now() > deadline) throw new Error('timeout waiting for condition');
			await new Promise<void>((ok) => {
				const t = setTimeout(ok, 50);
				this.waiters.push(() => {
					clearTimeout(t);
					ok();
				});
			});
		}
	}

	/** Wait for the first message of `type` after index `from`. */
	waitFor<K extends ServerMessage['type']>(
		type: K,
		pred: (m: Extract<ServerMessage, { type: K }>) => boolean = () => true,
		from = 0,
		ms = 2000
	): Promise<Extract<ServerMessage, { type: K }>> {
		return this.until(() =>
			this.messages
				.slice(from)
				.find((m): m is Extract<ServerMessage, { type: K }> => m.type === type && pred(m as Extract<ServerMessage, { type: K }>))
		, ms);
	}

	of<K extends ServerMessage['type']>(type: K): Extract<ServerMessage, { type: K }>[] {
		return this.messages.filter((m) => m.type === type) as Extract<ServerMessage, { type: K }>[];
	}

	/** `map`: the lobby to ask for (docs/architecture.md#lobbies); none = the server's default map. */
	async hello(name: string, playerId: string = crypto.randomUUID(), token?: string, map?: string) {
		await this.open();
		this.send({
			type: 'hello',
			playerId,
			name,
			version: PROTOCOL_VERSION,
			...(token === undefined ? {} : { token }),
			...(map === undefined ? {} : { map })
		});
		return this.waitFor('welcome');
	}

	/** Send register/login/logout and wait for the `auth` reply. */
	async auth(type: 'register' | 'login' | 'logout', username = '', password = '') {
		const n = this.messages.length;
		this.send(type === 'logout' ? { type } : { type, username, password });
		return this.waitFor('auth', () => true, n, 5000);
	}

	/** Round trip: makes sure everything sent before has been processed. */
	async barrier(): Promise<void> {
		const n = this.messages.length;
		this.send({ type: 'chat', text: '!help' });
		await this.waitFor('chat', (m) => m.system === true && m.text === 'Commands:', n);
	}

	close(): void {
		this.ws.close();
	}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
