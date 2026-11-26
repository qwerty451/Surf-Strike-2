/**
 * Dev launcher: game server on any gamemode or map, optional live WebSocket
 * bots, a local JSON control API, and the Vite web client, in one command.
 *
 *   pnpm play [mode-or-map] [flags]      (pnpm play -- --help)
 *
 * Runs from apps/server (`pnpm --filter server exec tsx ../../tools/dev-launch.ts`),
 * so the server code and its dependencies resolve as in `pnpm server`. The
 * pure helpers (argument parsing, target resolution, bot placement) are
 * exported for tools/dev-launch.test.ts; `main()` only runs when this file is
 * the entry point.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	BIN_ZOMBIES,
	decodeZombies,
	encodeState,
	FLAG_ON_GROUND,
	FLAG_TELEPORTED,
	GAME_MODE_IDS,
	GAME_MODES,
	getMap,
	isGameModeId,
	MAPS,
	mapsForMode,
	PROTOCOL_VERSION,
	SANDBOX,
	Status,
	tagSpawns,
	WEAPONS,
	withTeleportSeq,
	type GameModeId,
	type MapDef,
	type ServerMessage,
	type Spawn,
	type Vec3,
	type WeaponId
} from '../packages/shared/src/index.ts';
import type { ModeOptions } from '../apps/server/src/modes/index.ts';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOLS_DIR, '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 27016;
export const DEFAULT_WEB_PORT = 5173;
/** Bot state packets per second. */
export const BOT_HZ = 20;
/** Eye height above the feet (standing), for bot shots. */
export const EYE_HEIGHT = 64;

export interface LaunchOptions {
	target: string;
	/** null = mode default (see defaultBots). */
	bots: number | null;
	botPatrol: boolean;
	port: number;
	webPort: number;
	/** null = control API disabled. */
	ctrlPort: number | null;
	fast: boolean;
	grace: number | null;
	round: number | null;
	countdown: number | null;
	serverOnly: boolean;
	open: boolean;
	list: boolean;
	help: boolean;
	/** SQLite path; ':memory:' keeps the dev launcher off the real leaderboard. */
	db: string;
}

export class CliError extends Error {}

export const USAGE = `Usage: pnpm play [mode-or-map] [flags]

Starts a dev game server on a gamemode or map, optional live bots, a local
control API and the Vite web client, then prints the URL to open.

Target (default: surf)
  <mode>           ${GAME_MODE_IDS.join(', ')}: first map of that mode
  <map id>         any map id, including sandbox (pnpm play -- --list)

Flags
  --bots <N>       live WebSocket bots (default: 1 for tag/infected, else 0)
  --bot-patrol     bots walk a small circle around their spawn
  --port <P>       game server port (default ${DEFAULT_PORT})
  --web-port <W>   Vite port (default ${DEFAULT_WEB_PORT})
  --ctrl-port <C>  control API port (default: port + 1)
  --no-ctrl        no control API
  --fast           short round timers for tag, zombies and infected
  --grace <S>      infected grace period (seconds)
  --round <S>      tag and infected round length (seconds)
  --countdown <S>  zombies countdown and tag intermission (seconds)
  --db <path>      SQLite file (default :memory:, never the real leaderboard)
  --server-only    no Vite web server
  --open           open the game URL in the browser (macOS \`open\`)
  --list           print gamemodes and maps, then exit
  -h, --help       this help

Control API (http://127.0.0.1:<ctrl-port>)
  GET  /status                      map, mode, players, bots, modeState (/health too)
  POST /map?id=<mapId>              force a map change
  POST /bots?count=<N>              scale live bots up or down
  POST /bot/move?index=0&x=&y=&z=&yaw=&pitch=   teleport a bot (omitted axes keep)
  POST /bot/action?index=0&type=fire|throwKnife|placeBeacon|spectate|reload|loadout
        fire/throwKnife: aim with tx,ty,tz (point) or yaw/pitch; weapon=<id>
        fire after a loadout waits for the draw (infected); the reply names delayMs
        spectate: target=<playerId> to watch, none to leave (default: toggle)
        placeBeacon: infected bot plants a respawn beacon on the ground below it
        loadout: weapon=<id>
  POST /shutdown                    stop everything (bots, servers, Vite)

Examples
  pnpm play infected --bots 2 --fast --bot-patrol
  pnpm play tag_quayside --open
  pnpm play sandbox --server-only
  curl -X POST 'http://127.0.0.1:27017/bot/move?index=0&x=0&y=0&z=64'`;

function intArg(flag: string, raw: string | undefined, min: number, max: number): number {
	if (raw === undefined || raw.startsWith('--')) throw new CliError(`${flag} needs a value`);
	if (!/^\d+$/.test(raw)) throw new CliError(`${flag}: expected a whole number, got "${raw}"`);
	const n = Number(raw);
	if (n < min || n > max) throw new CliError(`${flag}: must be between ${min} and ${max}, got ${n}`);
	return n;
}

function secsArg(flag: string, raw: string | undefined): number {
	if (raw === undefined || raw.startsWith('--')) throw new CliError(`${flag} needs a value`);
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0 || n > 3600) throw new CliError(`${flag}: expected seconds in (0, 3600], got "${raw}"`);
	return n;
}

/** Parse CLI arguments (without node/script). Throws CliError on bad input. */
export function parseArgs(argv: readonly string[]): LaunchOptions {
	const o: LaunchOptions = {
		target: 'surf',
		bots: null,
		botPatrol: false,
		port: DEFAULT_PORT,
		webPort: DEFAULT_WEB_PORT,
		ctrlPort: null,
		fast: false,
		grace: null,
		round: null,
		countdown: null,
		serverOnly: false,
		open: false,
		list: false,
		help: false,
		db: ':memory:'
	};
	let ctrl: number | 'off' | null = null;
	let targetSet = false;
	// Accept --flag=value as well as --flag value.
	const args: string[] = [];
	for (const a of argv) {
		if (a === '--') continue; // `pnpm play -- --list` may forward the separator
		const eq = a.startsWith('--') ? a.indexOf('=') : -1;
		if (eq > 0) args.push(a.slice(0, eq), a.slice(eq + 1));
		else args.push(a);
	}
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		const next = () => args[++i];
		switch (a) {
			case '--bots':
				o.bots = intArg(a, next(), 0, 31);
				break;
			case '--bot-patrol':
				o.botPatrol = true;
				break;
			case '--port':
				o.port = intArg(a, next(), 1, 65535);
				break;
			case '--web-port':
				o.webPort = intArg(a, next(), 1, 65535);
				break;
			case '--ctrl-port':
				ctrl = intArg(a, next(), 1, 65535);
				break;
			case '--no-ctrl':
				ctrl = 'off';
				break;
			case '--fast':
				o.fast = true;
				break;
			case '--grace':
				o.grace = secsArg(a, next());
				break;
			case '--round':
				o.round = secsArg(a, next());
				break;
			case '--countdown':
				o.countdown = secsArg(a, next());
				break;
			case '--db': {
				const v = next();
				if (!v) throw new CliError('--db needs a value');
				o.db = v === ':memory:' ? v : resolve(process.env.INIT_CWD ?? process.cwd(), v);
				break;
			}
			case '--server-only':
				o.serverOnly = true;
				break;
			case '--open':
				o.open = true;
				break;
			case '--list':
				o.list = true;
				break;
			case '-h':
			case '--help':
				o.help = true;
				break;
			default:
				if (a.startsWith('-')) throw new CliError(`unknown flag: ${a} (see --help)`);
				if (targetSet) throw new CliError(`only one target allowed, got "${o.target}" and "${a}"`);
				o.target = a;
				targetSet = true;
		}
	}
	o.ctrlPort = ctrl === 'off' ? null : (ctrl ?? (o.port < 65535 ? o.port + 1 : null));
	if (o.ctrlPort !== null && o.ctrlPort === o.port) throw new CliError('--ctrl-port must differ from --port');
	if (!o.serverOnly && (o.webPort === o.port || o.webPort === o.ctrlPort)) {
		throw new CliError('--web-port must differ from the game and control ports');
	}
	return o;
}

/** Maps the launcher can start on: the rotation plus the sandbox. */
export function launchMaps(): MapDef[] {
	return [...MAPS, SANDBOX];
}

export interface Target {
	mapId: string;
	mode: GameModeId;
}

/** Gamemode id → its first rotation map; map id → that map. Throws CliError otherwise. */
export function resolveTarget(target: string, maps: readonly MapDef[] = launchMaps()): Target {
	const t = target.trim().toLowerCase();
	if (isGameModeId(t)) {
		const first = maps.find((m) => m.kind === t) ?? mapsForMode(t)[0];
		if (!first) throw new CliError(`gamemode "${t}" has no maps`);
		return { mapId: first.id, mode: t };
	}
	const map = maps.find((m) => m.id.toLowerCase() === t);
	if (map) return { mapId: map.id, mode: map.kind };
	throw new CliError(
		`unknown mode or map "${target}".\n  modes: ${GAME_MODE_IDS.join(', ')}\n  maps:  ${maps.map((m) => m.id).join(', ')}`
	);
}

/** Two-player modes get one bot so a round starts as soon as a browser joins. */
export function defaultBots(mode: GameModeId): number {
	return GAME_MODES[mode].minPlayers > 1 ? 1 : 0;
}

/** Gamemode timers for the lobby (`--fast` plus explicit overrides; applies to every map). */
export function modeOptions(o: Pick<LaunchOptions, 'fast' | 'grace' | 'round' | 'countdown'>): ModeOptions {
	const m: Required<Pick<ModeOptions, 'infected' | 'tag' | 'zombies'>> = { infected: {}, tag: {}, zombies: {} };
	if (o.fast) {
		Object.assign(m.infected, { graceSecs: 4, roundSecs: 90, endSecs: 4, respawnSecs: 2 });
		Object.assign(m.tag, { intermissionSecs: 3, roundSecs: 60 });
		Object.assign(m.zombies, { countdownSecs: 3, endSecs: 4 });
	}
	if (o.grace !== null) m.infected.graceSecs = o.grace;
	if (o.round !== null) {
		m.infected.roundSecs = o.round;
		m.tag.roundSecs = o.round;
	}
	if (o.countdown !== null) {
		m.zombies.countdownSecs = o.countdown;
		m.tag.intermissionSecs = o.countdown;
	}
	return m;
}

export function gameUrl(webPort: number, port: number): string {
	return `http://localhost:${webPort}/?server=ws://localhost:${port}/ws`;
}

/** `--list` output. */
export function listText(maps: readonly MapDef[] = launchMaps()): string {
	const lines: string[] = ['Gamemodes and maps (pnpm play <mode|map>):', ''];
	for (const id of GAME_MODE_IDS) {
		const own = maps.filter((m) => m.kind === id && m.id !== SANDBOX.id);
		lines.push(`  ${id.padEnd(9)} ${GAME_MODES[id].description}`);
		for (const [i, m] of own.entries()) {
			lines.push(`    ${m.id.padEnd(22)} ${m.title}${i === 0 ? '  (default for this mode)' : ''}`);
		}
	}
	lines.push('', `  extra     ${SANDBOX.id.padEnd(22)} ${SANDBOX.title} (physics test map, not in rotation)`);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Bot placement and motion (pure)
// ---------------------------------------------------------------------------

export interface Pose {
	x: number;
	y: number;
	z: number;
	/** Degrees. */
	yaw: number;
	pitch: number;
}

/** Units between bots that share one spawn point. */
export const BOT_RING = 48;

/**
 * Spawn pose for bot `index`. Bots take the map's spawn points from the
 * second one on (a browser usually lands on the first); when there are more
 * bots than points they fan out on a ring around the shared point.
 */
export function botSpawn(map: Pick<MapDef, 'spawn' | 'spawns'>, index: number): Pose {
	const list = tagSpawns(map);
	const slot = list.length > 1 ? (index + 1) % list.length : 0;
	const lap = list.length > 1 ? Math.floor((index + 1) / list.length) : index + 1;
	const s: Spawn = list[slot]!;
	if (lap === 0) return { x: s.pos.x, y: s.pos.y, z: s.pos.z, yaw: s.yaw, pitch: 0 };
	const a = (lap * 2 * Math.PI) / 6;
	const r = BOT_RING * Math.ceil(lap / 6);
	return { x: s.pos.x + Math.cos(a) * r, y: s.pos.y + Math.sin(a) * r, z: s.pos.z, yaw: s.yaw, pitch: 0 };
}

export const PATROL_RADIUS = 96;
export const PATROL_SPEED = 160; // u/s, walking pace

/**
 * Patrol: a circle of PATROL_RADIUS around `anchor`, starting at the anchor
 * itself (t = 0) so a teleport lands exactly where asked. Returns pose and
 * horizontal velocity; yaw faces along the path.
 */
export function patrolPose(anchor: Pose, tSecs: number, phase = 0): Pose & { vx: number; vy: number } {
	const w = PATROL_SPEED / PATROL_RADIUS;
	const a = phase + w * tSecs;
	// Circle centre offset from the anchor, so the path passes through it at t = 0.
	const cx = anchor.x - Math.cos(phase) * PATROL_RADIUS;
	const cy = anchor.y - Math.sin(phase) * PATROL_RADIUS;
	const vx = -Math.sin(a) * PATROL_SPEED;
	const vy = Math.cos(a) * PATROL_SPEED;
	return {
		x: cx + Math.cos(a) * PATROL_RADIUS,
		y: cy + Math.sin(a) * PATROL_RADIUS,
		z: anchor.z,
		yaw: (Math.atan2(vy, vx) * 180) / Math.PI,
		pitch: anchor.pitch,
		vx,
		vy
	};
}

/** Unit direction from yaw/pitch in degrees (Source: +pitch looks down). */
export function dirFromAngles(yaw: number, pitch: number): Vec3 {
	const y = (yaw * Math.PI) / 180;
	const p = (pitch * Math.PI) / 180;
	return { x: Math.cos(p) * Math.cos(y), y: Math.cos(p) * Math.sin(y), z: -Math.sin(p) };
}

/** Unit direction from `from` to `to`; null when they coincide. */
export function dirTowards(from: Vec3, to: Vec3): Vec3 | null {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const dz = to.z - from.z;
	const len = Math.hypot(dx, dy, dz);
	return len < 1e-6 ? null : { x: dx / len, y: dy / len, z: dz / len };
}

/**
 * How long a bot must still hold its fire after it switched to `weapon`
 * `sinceMs` ago (ms): the rest of the draw time (`WeaponDef.deployMs`). Only
 * infected has a draw time; its server rejects a shot fired before the weapon
 * is drawn ("too fast").
 */
export function drawWaitMs(mode: GameModeId, weapon: WeaponId, sinceMs: number): number {
	if (mode !== 'infected') return 0;
	const draw = WEAPONS[weapon]?.deployMs ?? 0;
	return Math.max(0, Math.ceil(draw - Math.max(0, sinceMs)));
}

/** Status a bot reports in its state packets for a mode (the server owns the real one). */
export function botStatus(mode: GameModeId): Status {
	if (mode === 'tag') return Status.Runner;
	if (mode === 'zombies' || mode === 'infected') return Status.Alive;
	return Status.StartZone;
}

// ---------------------------------------------------------------------------
// Live bots
// ---------------------------------------------------------------------------

export class Bot {
	readonly name: string;
	selfId = -1;
	mapId: string;
	mode: GameModeId;
	anchor: Pose;
	weapon: WeaponId = 'pistol';
	spectating = false;
	modeState: unknown = null;
	players = new Map<number, string>();
	private ws: WebSocket;
	private timer: ReturnType<typeof setInterval> | null = null;
	private t0 = performance.now();
	private anchorAt = performance.now();
	private teleported = true;
	private tpSeq = 0;
	private spawnSeq = 0;
	private zombieTick = 0;
	private closed = false;
	/** When the bot last switched weapons itself (the server enforces a draw time from then). */
	private swapAt = -Infinity;
	/** Shots held back until the weapon is drawn. */
	private held = new Set<ReturnType<typeof setTimeout>>();

	constructor(
		readonly index: number,
		port: number,
		map: MapDef,
		private patrol: () => boolean,
		private log: (msg: string) => void
	) {
		this.name = `Bot-${index + 1}`;
		this.mapId = map.id;
		this.mode = map.kind;
		this.anchor = botSpawn(map, index);
		this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		this.ws.binaryType = 'arraybuffer';
		this.ws.addEventListener('open', () => {
			this.ws.send(
				JSON.stringify({ type: 'hello', playerId: crypto.randomUUID(), name: this.name, version: PROTOCOL_VERSION })
			);
		});
		this.ws.addEventListener('message', (ev) => this.onMessage(ev.data));
		this.ws.addEventListener('close', () => {
			this.stopTimer();
			if (!this.closed) this.log(`${this.name} disconnected`);
			this.closed = true;
		});
		this.ws.addEventListener('error', () => {});
	}

	get connected(): boolean {
		return !this.closed && this.selfId >= 0;
	}

	private send(msg: unknown): void {
		if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
	}

	private onMessage(data: unknown): void {
		if (data instanceof ArrayBuffer) {
			if (new Uint8Array(data)[0] === BIN_ZOMBIES) {
				const f = decodeZombies(data);
				if (f) this.zombieTick = f.tick;
			}
			return;
		}
		let msg: ServerMessage;
		try {
			msg = JSON.parse(String(data)) as ServerMessage;
		} catch {
			return;
		}
		switch (msg.type) {
			case 'welcome':
				this.selfId = msg.selfId;
				this.players = new Map(msg.players.map((p) => [p.id, p.name]));
				this.onMap(msg.map);
				this.startTimer();
				break;
			case 'mapChange':
				this.modeState = null;
				this.onMap(msg.map);
				break;
			case 'join':
				this.players.set(msg.player.id, msg.player.name);
				break;
			case 'leave':
				this.players.delete(msg.id);
				break;
			case 'spectating':
				if (msg.id === this.selfId) this.spectating = msg.spectating;
				break;
			case 'modeState': {
				this.modeState = msg;
				// Zombies/infected list each player's held weapon; zombies' spawn event has none.
				if (msg.mode === 'zombies' || msg.mode === 'infected') {
					const me = msg.players.find((p) => p.id === this.selfId);
					if (me?.weapon) this.weapon = me.weapon;
				}
				break;
			}
			case 'ping':
				this.send({ type: 'pong', t: msg.t });
				break;
			case 'hns':
				if (msg.ev.e === 'spawn' && msg.ev.id === this.selfId && msg.spawnSeq !== this.spawnSeq) {
					this.spawnSeq = msg.spawnSeq ?? 0;
					this.moveTo({ ...msg.ev.pos, yaw: msg.ev.yaw });
				}
				break;
			case 'zm':
				if (msg.ev.e === 'spawn' && msg.ev.id === this.selfId && msg.spawnSeq !== this.spawnSeq) {
					this.spawnSeq = msg.spawnSeq ?? 0;
					this.moveTo(msg.ev);
				}
				break;
			case 'inf':
				if (msg.ev.e === 'spawn' && msg.ev.id === this.selfId && msg.spawnSeq !== this.spawnSeq) {
					this.spawnSeq = msg.spawnSeq ?? 0;
					this.weapon = msg.ev.weapon;
					// Handed out by the server: already drawn.
					this.swapAt = -Infinity;
					this.moveTo(msg.ev);
				}
				break;
			case 'full':
				this.log(`${this.name}: server full`);
				break;
		}
	}

	private onMap(id: string): void {
		const map = getMap(id);
		this.mapId = id;
		if (!map) return;
		this.mode = map.kind;
		this.moveTo(botSpawn(map, this.index));
	}

	/** Teleport the bot (anchor of its patrol); missing fields keep their value. */
	moveTo(p: Partial<Pose>): void {
		this.anchor = {
			x: p.x ?? this.anchor.x,
			y: p.y ?? this.anchor.y,
			z: p.z ?? this.anchor.z,
			yaw: p.yaw ?? this.anchor.yaw,
			pitch: p.pitch ?? this.anchor.pitch
		};
		this.anchorAt = performance.now();
		this.teleported = true;
	}

	/** Where the bot is right now. */
	pose(now = performance.now()): Pose & { vx: number; vy: number } {
		if (!this.patrol()) return { ...this.anchor, vx: 0, vy: 0 };
		return patrolPose(this.anchor, (now - this.anchorAt) / 1000, this.index * 1.3);
	}

	private startTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.sendState(), 1000 / BOT_HZ);
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private sendState(): void {
		if (this.ws.readyState !== WebSocket.OPEN || this.spectating) return;
		const now = performance.now();
		const p = this.pose(now);
		if (this.teleported) this.tpSeq = (this.tpSeq + 1) & 0xff;
		const flags = withTeleportSeq(FLAG_ON_GROUND | (this.teleported ? FLAG_TELEPORTED : 0), this.tpSeq);
		this.teleported = false;
		this.ws.send(
			encodeState({
				tick: Math.round(((now - this.t0) / 1000) * 64),
				spawnSeq: this.spawnSeq,
				x: p.x,
				y: p.y,
				z: p.z,
				vx: p.vx,
				vy: p.vy,
				vz: 0,
				pitch: p.pitch,
				yaw: p.yaw,
				flags,
				status: botStatus(this.mode),
				stage: 1,
				runTicks: 0
			})
		);
	}

	/** Aim: explicit point, else explicit angles, else the bot's current facing. */
	private aim(q: AimQuery): { origin: Vec3; dir: Vec3 } {
		const p = this.pose();
		const origin = { x: p.x, y: p.y, z: p.z + EYE_HEIGHT };
		const point = q.tx !== undefined && q.ty !== undefined && q.tz !== undefined ? { x: q.tx, y: q.ty, z: q.tz } : null;
		const dir = (point && dirTowards(origin, point)) ?? dirFromAngles(q.yaw ?? p.yaw, q.pitch ?? p.pitch);
		return { origin, dir };
	}

	/**
	 * Fire, or hold the shot until the weapon the bot just switched to is
	 * drawn (the server would reject it). Returns the delay in ms; the aim is
	 * taken when the shot leaves.
	 */
	fire(q: AimQuery, weapon?: WeaponId): number {
		const wait = drawWaitMs(this.mode, this.weapon, performance.now() - this.swapAt);
		if (wait <= 0) {
			this.shoot(q, weapon);
			return 0;
		}
		const timer = setTimeout(() => {
			this.held.delete(timer);
			// Checked again: the bot may have switched once more meanwhile.
			if (!this.closed) this.fire(q, weapon);
		}, wait);
		this.held.add(timer);
		return wait;
	}

	private shoot(q: AimQuery, weapon?: WeaponId): void {
		const { origin, dir } = this.aim(q);
		// Infected reads 2^31-1 as a live shot: the server rewinds the targets by the ping, the client
		// interpolation delay and half a snapshot interval (infRewindMs). Zombies wants the last sim tick seen.
		const tick = this.mode === 'zombies' ? this.zombieTick : 0x7fffffff;
		this.send({ type: 'fire', weapon: weapon ?? this.weapon, origin, dir, tick });
	}

	throwKnife(q: AimQuery): void {
		const { origin, dir } = this.aim(q);
		this.send({ type: 'throwKnife', origin, dir });
	}

	/** Infected: plant a respawn beacon on the ground below (the server checks ground and cooldown). */
	placeBeacon(): void {
		this.send({ type: 'placeBeacon' });
	}

	reload(): void {
		this.send({ type: 'reload' });
	}

	loadout(weapon: WeaponId): void {
		this.weapon = weapon;
		this.swapAt = performance.now();
		this.send({ type: 'loadout', weapon });
	}

	/** target: a player id to watch, null to leave spectate, undefined to toggle. */
	spectate(target?: number | null): number | null {
		let t: number | null;
		if (target === undefined) {
			t = this.spectating ? null : ([...this.players.keys()].find((id) => id !== this.selfId) ?? null);
			if (!this.spectating && t === null) throw new Error('nobody else to spectate');
		} else t = target;
		this.send({ type: 'spectate', targetId: t });
		return t;
	}

	close(): void {
		this.closed = true;
		this.stopTimer();
		for (const t of this.held) clearTimeout(t);
		this.held.clear();
		try {
			this.ws.close(1000, 'dev launcher stopping');
		} catch {
			// already closed
		}
	}
}

export interface AimQuery {
	tx?: number;
	ty?: number;
	tz?: number;
	yaw?: number;
	pitch?: number;
}

// ---------------------------------------------------------------------------
// Control API
// ---------------------------------------------------------------------------

/** Lobby internals the launcher needs; `rotation`/`handleRotation` are private, reached through a cast. */
interface LobbyHandle {
	currentMap: MapDef;
	playerCount: number;
	gameMode: { id: GameModeId; stateMessage?: () => unknown };
}

interface ControlDeps {
	lobby: LobbyHandle;
	port: number;
	webUrl: string | null;
	bots: () => Bot[];
	setBots: (n: number) => Promise<void>;
	forceMap: (id: string) => string | null;
	shutdown: () => void;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

function num(q: URLSearchParams, key: string): number | undefined {
	const v = q.get(key);
	if (v === null || v === '') return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) throw new HttpError(400, `${key}: not a number: "${v}"`);
	return n;
}

function botAt(deps: ControlDeps, q: URLSearchParams): Bot {
	const i = num(q, 'index') ?? 0;
	const bot = deps.bots()[i];
	if (!bot) throw new HttpError(404, `no bot at index ${i} (${deps.bots().length} running; POST /bots?count=N)`);
	return bot;
}

function weaponArg(q: URLSearchParams): WeaponId | undefined {
	const w = q.get('weapon');
	return w ? (w as WeaponId) : undefined;
}

function status(deps: ControlDeps) {
	const { lobby } = deps;
	return {
		map: lobby.currentMap.id,
		mode: lobby.currentMap.kind,
		port: deps.port,
		webUrl: deps.webUrl,
		players: lobby.playerCount,
		bots: deps.bots().map((b) => {
			const p = b.pose();
			return {
				index: b.index,
				name: b.name,
				id: b.selfId,
				connected: b.connected,
				spectating: b.spectating,
				weapon: b.weapon,
				pos: { x: round(p.x), y: round(p.y), z: round(p.z), yaw: round(p.yaw), pitch: round(p.pitch) }
			};
		}),
		modeState: lobby.gameMode.stateMessage?.() ?? null
	};
}

const round = (n: number) => Math.round(n * 100) / 100;

async function route(deps: ControlDeps, method: string, path: string, q: URLSearchParams): Promise<unknown> {
	if (path === '/' || path === '/health' || path === '/status') {
		if (method !== 'GET') throw new HttpError(405, 'use GET');
		return status(deps);
	}
	if (method !== 'POST') throw new HttpError(405, `use POST for ${path}`);
	switch (path) {
		case '/map': {
			const id = q.get('id');
			if (!id) throw new HttpError(400, 'id is required');
			const err = deps.forceMap(id);
			if (err) throw new HttpError(400, err);
			return { ok: true, map: id };
		}
		case '/shutdown':
			setTimeout(deps.shutdown, 50); // reply first
			return { ok: true, stopping: true };
		case '/bots': {
			const n = num(q, 'count');
			if (n === undefined || !Number.isInteger(n) || n < 0 || n > 31) throw new HttpError(400, 'count: 0..31');
			await deps.setBots(n);
			return { ok: true, bots: deps.bots().length };
		}
		case '/bot/move': {
			const bot = botAt(deps, q);
			bot.moveTo({ x: num(q, 'x'), y: num(q, 'y'), z: num(q, 'z'), yaw: num(q, 'yaw'), pitch: num(q, 'pitch') });
			return { ok: true, bot: bot.name, pos: bot.anchor };
		}
		case '/bot/action': {
			const bot = botAt(deps, q);
			const type = q.get('type');
			const aim: AimQuery = { tx: num(q, 'tx'), ty: num(q, 'ty'), tz: num(q, 'tz'), yaw: num(q, 'yaw'), pitch: num(q, 'pitch') };
			switch (type) {
				case 'fire':
					return { ok: true, bot: bot.name, action: type, delayMs: bot.fire(aim, weaponArg(q)) };
				case 'throwKnife':
					bot.throwKnife(aim);
					return { ok: true, bot: bot.name, action: type };
				case 'placeBeacon':
					bot.placeBeacon();
					return { ok: true, bot: bot.name, action: type };
				case 'reload':
					bot.reload();
					return { ok: true, bot: bot.name, action: type };
				case 'loadout': {
					const w = weaponArg(q);
					if (!w) throw new HttpError(400, 'weapon is required');
					bot.loadout(w);
					return { ok: true, bot: bot.name, action: type, weapon: w };
				}
				case 'spectate': {
					const raw = q.get('target');
					const target = raw === null ? undefined : raw === 'none' || raw === '' ? null : num(q, 'target');
					try {
						return { ok: true, bot: bot.name, action: type, target: bot.spectate(target) };
					} catch (e) {
						throw new HttpError(409, (e as Error).message);
					}
				}
				default:
					throw new HttpError(400, 'type: fire | throwKnife | placeBeacon | spectate | reload | loadout');
			}
		}
	}
	throw new HttpError(404, `unknown endpoint ${path}`);
}

function startControl(deps: ControlDeps, port: number): Promise<Server> {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const reply = (code: number, body: unknown) => {
			res.writeHead(code, {
				'content-type': 'application/json',
				'cache-control': 'no-store',
				'access-control-allow-origin': '*'
			});
			res.end(JSON.stringify(body, null, 2) + '\n');
		};
		req.resume();
		route(deps, req.method ?? 'GET', url.pathname.replace(/\/+$/, '') || '/', url.searchParams).then(
			(body) => reply(200, body),
			(e: unknown) => reply(e instanceof HttpError ? e.status : 500, { ok: false, error: (e as Error).message })
		);
	});
	return new Promise((ok, fail) => {
		server.once('error', fail);
		server.listen(port, '127.0.0.1', () => {
			server.off('error', fail);
			ok(server);
		});
	});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function log(msg: string): void {
	console.log(`[play] ${msg}`);
}

async function waitForHttp(url: string, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
			await res.body?.cancel();
			return true;
		} catch {
			await new Promise((r) => setTimeout(r, 300));
		}
	}
	return false;
}

/**
 * Is `port` free on the default (dual-stack) address the game server binds?
 * Checked up front because a listen error inside startServer is re-emitted
 * by the WebSocketServer as an unhandled 'error' event and crashes the process.
 */
function portFree(port: number): Promise<boolean> {
	return new Promise((ok) => {
		const probe = createNetServer();
		probe.once('error', () => ok(false));
		probe.listen(port, () => probe.close(() => ok(true)));
	});
}

function startVite(webPort: number): ChildProcess {
	const webDir = resolve(ROOT, 'apps/web');
	const bin = resolve(webDir, 'node_modules/.bin/vite');
	if (!existsSync(bin)) throw new Error(`Vite not found at ${bin}; run pnpm install`);
	// Own process group so shutdown can kill Vite and anything it spawned.
	return spawn(bin, ['dev', '--port', String(webPort), '--strictPort'], {
		cwd: webDir,
		stdio: ['ignore', 'inherit', 'inherit'],
		detached: true,
		env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' }
	});
}

function killGroup(child: ChildProcess | null, signal: NodeJS.Signals = 'SIGTERM'): void {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// gone
		}
	}
}

export async function main(argv: readonly string[]): Promise<number> {
	let opts: LaunchOptions;
	let target: Target;
	try {
		opts = parseArgs(argv);
		if (opts.help) {
			console.log(USAGE);
			return 0;
		}
		if (opts.list) {
			console.log(listText());
			return 0;
		}
		target = resolveTarget(opts.target);
	} catch (e) {
		if (e instanceof CliError) {
			console.error(`play: ${e.message}`);
			return 2;
		}
		throw e;
	}

	const botCount = opts.bots ?? defaultBots(target.mode);
	if (!(await portFree(opts.port))) {
		console.error(`play: port ${opts.port} is in use (another \`pnpm server\` or \`pnpm play\`?). Pick one with --port.`);
		return 1;
	}
	const { startServer } = await import('../apps/server/src/server.ts');
	let server: Awaited<ReturnType<typeof startServer>>;
	try {
		server = await startServer({
			port: opts.port,
			dbPath: opts.db,
			maps: launchMaps(),
			initialMap: target.mapId,
			modes: modeOptions(opts),
			log: (m) => console.log(`[server] ${m}`)
		});
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		console.error(
			err.code === 'EADDRINUSE'
				? `play: port ${opts.port} is in use (another \`pnpm server\` or \`pnpm play\`?). Pick one with --port.`
				: `play: game server failed: ${err.message}`
		);
		return 1;
	}
	const lobby = server.lobby as unknown as LobbyHandle & {
		rotation: { forceMap(id: string, now: number): unknown };
		handleRotation(evs: unknown[]): void;
	};

	let bots: Bot[] = [];
	let patrol = opts.botPatrol;
	const setBots = async (n: number) => {
		while (bots.length > n) bots.pop()!.close();
		const added: Bot[] = [];
		while (bots.length < n) {
			const b = new Bot(bots.length, server.port, lobby.currentMap, () => patrol, log);
			bots.push(b);
			added.push(b);
		}
		// Wait (briefly) for the new bots' welcome so callers see their ids.
		const deadline = Date.now() + 3000;
		while (added.some((b) => !b.connected) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
	};
	const forceMap = (id: string): string | null => {
		if (!getMap(id)) return `unknown map "${id}"`;
		const ev = lobby.rotation.forceMap(id, Date.now());
		if (!ev) return `map "${id}" cannot be loaded (not served)`;
		lobby.handleRotation([ev]);
		return null;
	};

	const webUrl = opts.serverOnly ? null : gameUrl(opts.webPort, server.port);
	let ctrl: Server | null = null;
	let vite: ChildProcess | null = null;
	let stopping = false;

	const shutdown = async (code: number) => {
		if (stopping) return;
		stopping = true;
		log('stopping…');
		for (const b of bots) b.close();
		bots = [];
		killGroup(vite);
		const viteGone = vite && vite.exitCode === null ? new Promise((r) => vite!.once('exit', r)) : Promise.resolve();
		const force = setTimeout(() => killGroup(vite, 'SIGKILL'), 3000);
		await Promise.all([
			ctrl ? new Promise<void>((r) => ctrl!.close(() => r())).then(() => ctrl!.closeAllConnections()) : null,
			server.close(),
			viteGone
		]);
		clearTimeout(force);
		process.exit(code);
	};
	const onSignal = () => {
		if (stopping) process.exit(130); // second Ctrl+C: don't wait
		void shutdown(0);
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
	process.on('SIGHUP', onSignal); // terminal closed: don't leave the detached Vite behind
	process.once('exit', () => killGroup(vite, 'SIGKILL'));

	if (opts.ctrlPort !== null) {
		try {
			ctrl = await startControl({ lobby, port: server.port, webUrl, bots: () => bots, setBots, forceMap, shutdown: () => void shutdown(0) }, opts.ctrlPort);
		} catch (e) {
			console.error(`play: control API on ${opts.ctrlPort} failed: ${(e as Error).message} (use --ctrl-port or --no-ctrl)`);
			await shutdown(1);
			return 1;
		}
	}

	await setBots(botCount);

	if (!opts.serverOnly) {
		try {
			vite = startVite(opts.webPort);
		} catch (e) {
			console.error(`play: ${(e as Error).message}`);
			await shutdown(1);
			return 1;
		}
		vite.once('exit', (code, sig) => {
			if (!stopping) {
				console.error(`play: Vite exited (${sig ?? code}); is port ${opts.webPort} free? Stopping.`);
				void shutdown(1);
			}
		});
	}

	const map = lobby.currentMap;
	const ctrlBase = opts.ctrlPort !== null ? `http://127.0.0.1:${opts.ctrlPort}` : null;
	const lines = [
		'',
		'────────────────────────────────────────────────────────────',
		` Surf Strike 2 dev · ${GAME_MODES[map.kind].label} · ${map.title} (${map.id})`,
		'────────────────────────────────────────────────────────────',
		webUrl ? ` Play:     ${webUrl}` : ` Play:     (--server-only) point a client at ws://localhost:${server.port}/ws`,
		` Server:   ws://localhost:${server.port}/ws   (http://localhost:${server.port}/health)`,
		` Bots:     ${bots.length}${bots.length ? (patrol ? ' (patrolling)' : ' (standing)') : ''}   DB: ${opts.db}`,
		ctrlBase
			? ` Control:  ${ctrlBase}/status · POST /map?id= · /bots?count= · /bot/move · /bot/action`
			: ' Control:  disabled (--no-ctrl)',
		' Ctrl+C stops everything.',
		''
	];
	console.log(lines.join('\n'));

	if (opts.open) {
		if (!webUrl) log('--open ignored with --server-only');
		else if (process.platform !== 'darwin') log(`--open only works on macOS; open ${webUrl} yourself`);
		else if (await waitForHttp(`http://localhost:${opts.webPort}/`, 30_000)) {
			spawn('open', [webUrl], { stdio: 'ignore', detached: true }).unref();
		} else log(`Vite did not answer within 30 s; open ${webUrl} yourself`);
	}
	return -1; // keep running
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
	main(process.argv.slice(2)).then(
		(code) => {
			if (code >= 0) process.exit(code);
		},
		(e: unknown) => {
			console.error(e);
			process.exit(1);
		}
	);
}
