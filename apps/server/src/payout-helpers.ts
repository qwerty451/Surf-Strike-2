/** A gamemode with the real economy on fake clocks and players, for the payout tests. Not a test file itself. */
import { FLAG_ON_GROUND, Status, type MapDef, type NetState, type ServerMessage } from '@surf/shared';
import { world, type SimPlayer } from './economy-helpers.ts';
import type { ModeHost, ServerMode } from './modes/types.ts';

/** One mode tick (ms). */
export const STEP = 1000 / 32;

type Body = SimPlayer & { state: NetState | null; ping: number };

export function modeWorld<M extends ServerMode>(map: MapDef, make: (host: ModeHost) => M, rng: () => number = () => 0) {
	const w = world(map);
	const at = new Map<number, NetState>();
	/** Players who stand still and send nothing new. */
	const afk = new Set<number>();
	/** Looking around like a person, on top of the placed view (economy only). */
	const look = new Map<number, number>();
	const host: ModeHost = {
		map,
		db: w.db,
		economy: w.mode,
		now: () => w.now,
		rng,
		players: () => w.players as Set<Body>,
		send: (p, msg) => {
			w.economy.sent(p as Body, msg);
			s.onSend(p.id, msg);
		},
		broadcast: (msg) => s.onBroadcast(msg),
		sendBinary: () => {},
		broadcastBinary: () => {},
		system: () => {},
		systemTo: () => {},
		guestRunNotice: () => {},
		log: () => {}
	};
	const s = {
		w,
		afk,
		mode: make(host),
		onSend: (_id: number, _msg: ServerMessage): void => {},
		onBroadcast: (_msg: ServerMessage): void => {},
		/** Join the mode at a place and be active. */
		enter(p: SimPlayer, x = p.id * 100, y = 0): SimPlayer {
			(p as Body).ping = 0;
			s.put(p, x, y);
			s.mode.join(p as Body);
			return p;
		},
		join(n: number, ip?: (i: number) => string | null): SimPlayer[] {
			const ps = w.join(n, ip);
			for (const p of ps) s.enter(p);
			s.run(1);
			return ps;
		},
		leave(p: SimPlayer): void {
			w.players.delete(p);
			s.mode.leave(p as Body);
			w.economy.leave(p);
		},
		spectate(p: SimPlayer, on: boolean): void {
			p.spectating = on;
			(p as Body).state = null;
			w.economy.spectate(p);
			s.mode.spectate(p as Body, on);
			if (!on) s.put(p, at.get(p.id)!.x, at.get(p.id)!.y);
		},
		/** Stand there (the economy is told about the jump). */
		put(p: SimPlayer, x: number, y: number, z = 0.25, yaw = 0, vx = 0, vy = 0): void {
			w.economy.forMode().teleported(p.id);
			at.set(p.id, { tick: 0, x, y, z, vx, vy, vz: 0, pitch: 0, yaw, flags: FLAG_ON_GROUND, status: Status.Runner, stage: 0, runTicks: 0 });
			s.packet(p);
		},
		/** Send the player's state; everyone but the AFK shuffles about for the economy. */
		packet(p: SimPlayer): void {
			const st = at.get(p.id)!;
			st.tick += 2;
			(p as Body).state = { ...st };
			const shuffle = afk.has(p.id) ? 0 : Math.floor(w.clock / 1000) % 2 ? 40 : 0;
			if (!afk.has(p.id) && p.rng() < 4 / 32) look.set(p.id, (look.get(p.id) ?? 0) + (p.rng() - 0.5) * 120);
			w.economy.state(p, { ...st, x: st.x + shuffle, yaw: look.get(p.id) ?? 0 });
			s.mode.state(p as Body, (p as Body).state!);
		},
		/** Let `secs` pass at 32 Hz; `each` may move players. */
		run(secs: number, each?: (t: number) => void): void {
			for (let t = 0; t < secs * 1000 - 1e-6; t += STEP) {
				w.now += STEP;
				w.clock += STEP;
				each?.(t / 1000);
				for (const p of w.players) if (!p.spectating) s.packet(p);
				s.mode.tick();
				w.economy.tick();
			}
		},
		runUntil(done: () => boolean, maxSecs = 600): void {
			for (let t = 0; t < maxSecs && !done(); t += STEP / 1000) s.run(STEP / 1000);
			if (!done()) throw new Error('not reached');
		},
		send(p: SimPlayer, msg: Parameters<NonNullable<ServerMode['message']>>[1]): void {
			s.mode.message!(p as Body, msg);
		},
		/** Paid to the account so far, base tenths by reason (and multiplier ×1 amounts ignored). */
		paid(p: SimPlayer, reason: string): number {
			return (w.db.db.prepare('SELECT COALESCE(SUM(base), 0) AS n FROM point_log WHERE account_id = ? AND reason = ?').get(p.accountId, reason) as { n: number }).n;
		},
		warnings(): string[] {
			return w.db.abuseLog(100).map((r) => `${r.action} ${r.username}`);
		}
	};
	return s;
}
