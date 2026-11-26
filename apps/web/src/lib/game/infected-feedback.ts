/**
 * Infected hit and kill feedback (docs/modes.md#infected): what the server's
 * events show and sound like in the world. InfectedClient calls these from
 * its `apply()` cases, `frame()` and `shoot()`. Every effect is optional: no
 * renderer, an undrawn avatar and test fakes without the newer members all
 * just show nothing.
 */
import { infReloadMs, WEAPONS, type CollisionWorld, type InfEvent, type InfStateView, type Vec3 } from '@surf/shared';
import { HELD } from '../render/character/held.js';
import { BOLT_MS } from '../render/fp-clips.js';
import type { InfectedFx } from '../render/infected-fx.js';
import { emptyPose, type RemotePlayers } from '../render/players.js';
import type { ZombieRenderer } from '../render/zombies.js';
import type { InfHost, InfRole, InfSound } from './infected.js';

type Ev<K extends InfEvent['e']> = Extract<InfEvent, { e: K }>;
type World = Pick<CollisionWorld, 'trace'>;
/** What the world feedback needs of a host (the tournament client shares these helpers). */
export type FxHost = Pick<InfHost, 'infectedRenderer' | 'remotePlayers' | 'sound'>;

/** Positional sounds of a body come from chest height above the feet. */
export const BODY_SOUND_Z = 40;
/** A shot that ends within this far of a surface hit it (the server's length stops just short). */
const IMPACT_SLACK = 8;
/** A remote tracer starts at the drawn muzzle only when that is this close to the shot origin (avatars lag ~100 ms). */
const MUZZLE_MAX_DIST = 96;
/** Tracer start below the eye when the shooter's gun is not drawn. */
const EYE_DROP = 6;
/** Pellets read from one `shot` event at most. */
const MAX_PELLETS = 16;
/** A M.O.A.B. wipe collapses as a wave: delay per body, capped (ms). */
const WIPE_STAGGER_MS = 35;
const WIPE_STAGGER_MAX_MS = 280;

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const FROM = { x: 0, y: 0, z: 0 };
const FROM2 = { x: 0, y: 0, z: 0 };
const VEL = { x: 0, y: 0, z: 0 };
const TO = { x: 0, y: 0, z: 0 };
const END = { x: 0, y: 0, z: 0 };
const HIT = { x: 0, y: 0, z: 0 };
const NOR = { x: 0, y: 0, z: 0 };
const AV = emptyPose();
const AV2 = emptyPose();

const fxOf = (host: FxHost): InfectedFx | null => host.infectedRenderer()?.fx ?? null;
const avatars = (host: FxHost): RemotePlayers | null => host.remotePlayers?.() ?? null;

/** Hit sound by the event flags: a kill beats a headshot; a beacon (target 0) keeps the plain hit. */
export function hitSound(ev: Ev<'hit'>): InfSound {
	if (ev.targetId === 0) return 'hit';
	return ev.kill ? 'hitKill' : ev.head ? 'hitHead' : 'hit';
}

/** My shot hit: the victim's avatar flashes, and the hit sounds. */
export function hitFeedback(host: FxHost, ev: Ev<'hit'>, now: number): void {
	if (ev.targetId !== 0) avatars(host)?.flash(ev.targetId, now);
	host.sound(hitSound(ev));
}

/**
 * An infected was killed: it is down at once (the avatar must not stand next
 * to its corpse until the next state), and its body collapses at the death
 * pose in its own look, falling away from the killer. `eye`: my eye when I am
 * the killer. No corpse for the view player (the camera sits in its head).
 */
export function killFeedback(host: InfHost, state: InfStateView | null, ev: Ev<'kill'>, me: number, viewId: number, eye: Vec3 | null, role: InfRole, now: number): void {
	const p = state?.players.find((q) => q.id === ev.targetId);
	if (p) p.alive = false;
	host.sound('death', { x: ev.x, y: ev.y, z: ev.z + BODY_SOUND_Z });
	const fx = fxOf(host);
	const players = avatars(host);
	players?.stopReload(ev.targetId);
	if (!fx || ev.targetId === viewId || players?.isHidden) return;
	const drawn = players?.pose(ev.targetId, AV) ?? false;
	const from = ev.by === me ? eye : players?.pose(ev.by, AV2) ? AV2 : null;
	fx.corpse(
		{
			x: ev.x,
			y: ev.y,
			z: ev.z,
			yaw: ev.yaw,
			id: ev.targetId,
			fx: from ? ev.x - from.x : undefined,
			fy: from ? ev.y - from.y : undefined
		},
		role === 'alpha' ? 'alpha' : 'infected',
		now,
		drawn ? players!.model(ev.targetId) : null
	);
}

/**
 * A M.O.A.B. went off: every living infected is down at once and collapses
 * where its avatar stands (the event carries no poses), as a short wave.
 */
export function moabFeedback(host: InfHost, state: InfStateView | null, viewId: number, now: number): void {
	if (!state) return;
	const fx = fxOf(host);
	const players = avatars(host);
	let n = 0;
	for (const p of state.players) {
		if (p.team !== 'infected' || !p.alive) continue;
		p.alive = false;
		players?.stopReload(p.id);
		if (!fx || !players || players.isHidden || p.id === viewId || !players.pose(p.id, AV)) continue;
		const a = Math.random() * Math.PI * 2;
		fx.corpse(
			{ x: AV.x, y: AV.y, z: AV.z, yaw: AV.yaw, fx: Math.cos(a), fy: Math.sin(a), delay: Math.min(WIPE_STAGGER_MAX_MS, n * WIPE_STAGGER_MS) },
			p.alpha ? 'alpha' : 'infected',
			now,
			players.model(p.id)
		);
		n++;
	}
}

/**
 * A survivor turned: a burst at the body and the avatar easing into the
 * infected look; the sound comes from the body. My own infection sounds
 * without a position.
 */
export function turnFeedback(host: InfHost, ev: Ev<'infect'>, me: number, now: number): void {
	if (ev.id === me) {
		host.sound('infect');
		return;
	}
	const players = avatars(host);
	if (!players) return;
	players.turn(ev.id, now);
	if (!players.pose(ev.id, AV)) return;
	if (!players.isHidden) fxOf(host)?.turn(AV, now);
	host.sound('infect', { x: AV.x, y: AV.y, z: AV.z + BODY_SOUND_Z });
}

/**
 * Where a shot of length `len` along the unit direction (dx, dy, dz) met the
 * map: fills HIT and NOR and returns true. A shot that ran out of range, or
 * ended on a player (the map is not there), returns false. Without a
 * collision world every shot shorter than the range counts, normal unknown.
 */
function worldHit(world: World | null, o: Vec3, dx: number, dy: number, dz: number, len: number, range: number): boolean {
	if (!(len > 0) || len >= range - 0.5) return false;
	if (!world) {
		HIT.x = o.x + dx * len;
		HIT.y = o.y + dy * len;
		HIT.z = o.z + dz * len;
		NOR.x = NOR.y = NOR.z = 0;
		return true;
	}
	const reach = len + IMPACT_SLACK;
	END.x = o.x + dx * reach;
	END.y = o.y + dy * reach;
	END.z = o.z + dz * reach;
	const t = world.trace(o, END, ZERO, ZERO);
	if (t.fraction >= 1) return false;
	HIT.x = t.endpos.x;
	HIT.y = t.endpos.y;
	HIT.z = t.endpos.z;
	NOR.x = t.plane.normal.x;
	NOR.y = t.plane.normal.y;
	NOR.z = t.plane.normal.z;
	return true;
}

/** Sparks and dust where a ray met the map; returns whether it did. */
function impact(fx: InfectedFx | null, world: World | null, o: Vec3, dx: number, dy: number, dz: number, len: number, range: number, now: number): boolean {
	if (!worldHit(world, o, dx, dy, dz, len, range)) return false;
	fx?.impact(HIT, NOR, now);
	return true;
}

/**
 * My own shot: the impact where its tracer ends on the map (`len` shorter
 * than the range). `sound`: play the impact sound (once per trigger pull).
 */
export function localImpact(host: FxHost, world: World | null, eye: Vec3, d: Vec3, len: number, range: number, now: number, sound: boolean): void {
	if (!impact(fxOf(host), world, eye, d.x, d.y, d.z, len, range, now)) return;
	if (sound) host.sound('impact', { x: HIT.x, y: HIT.y, z: HIT.z });
}

/**
 * Another player's shot or swing: the avatar's muzzle flash and recoil (or
 * arm chop), one tracer per pellet from the muzzle of the gun it holds, and
 * an impact where each pellet met the map. One impact sound per shot.
 */
export function shotFeedback(host: FxHost, world: World | null, r: ZombieRenderer | null, ev: Ev<'shot'>, now: number): void {
	const players = avatars(host);
	players?.fired(ev.by, now);
	const def = WEAPONS[ev.weapon];
	if (def.magazine === 0 || !(ev.len > 0)) return;
	const o = ev.o;
	// An undrawn shooter's tracer starts below the eye.
	if (!players?.muzzle(ev.by, FROM) || Math.hypot(FROM.x - o.x, FROM.y - o.y, FROM.z - o.z) > MUZZLE_MAX_DIST) {
		FROM.x = o.x;
		FROM.y = o.y;
		FROM.z = o.z - EYE_DROP;
	}
	ejectCase(r, players, ev, now);
	const fx = fxOf(host);
	let at: Vec3 | null = null;
	TO.x = o.x + ev.d.x * ev.len;
	TO.y = o.y + ev.d.y * ev.len;
	TO.z = o.z + ev.d.z * ev.len;
	r?.tracer(FROM, TO, now);
	if (impact(fx, world, o, ev.d.x, ev.d.y, ev.d.z, ev.len, def.range, now)) at = { x: HIT.x, y: HIT.y, z: HIT.z };
	const p = ev.pellets;
	if (Array.isArray(p)) {
		const n = Math.min(p.length - (p.length % 4), MAX_PELLETS * 4);
		for (let i = 0; i < n; i += 4) {
			const dx = p[i]!;
			const dy = p[i + 1]!;
			const dz = p[i + 2]!;
			const len = p[i + 3]!;
			if (!Number.isFinite(dx + dy + dz + len) || len <= 0) continue;
			TO.x = o.x + dx * len;
			TO.y = o.y + dy * len;
			TO.z = o.z + dz * len;
			r?.tracer(FROM, TO, now);
			if (impact(fx, world, o, dx, dy, dz, len, def.range, now) && !at) at = { x: HIT.x, y: HIT.y, z: HIT.z };
		}
	}
	if (at) host.sound('impact', at);
}

/** The case of another player's shot, out of the gun the avatar holds (behind its muzzle); the sniper's as its bolt opens. */
function ejectCase(r: ZombieRenderer | null, players: RemotePlayers | null, ev: Ev<'shot'>, now: number): void {
	if (!r?.casings || ev.weapon === 'claws' || ev.weapon === 'knife' || !players?.pose(ev.by, AV) || !players.muzzle(ev.by, FROM2)) return;
	const back = HELD[ev.weapon].muzzle![0] * 0.7;
	FROM2.x -= ev.d.x * back;
	FROM2.y -= ev.d.y * back;
	FROM2.z -= ev.d.z * back;
	VEL.x = AV.vx;
	VEL.y = AV.vy;
	VEL.z = AV.vz;
	r.casings.ejectOther(ev.weapon, FROM2, ev.d, VEL, now, ev.weapon === 'sniper' ? BOLT_MS * 0.55 : 0);
}

/**
 * Another player's reload: the avatar reloads for as long as the event says,
 * and it sounds from the avatar (chest height, like the other body sounds; no
 * avatar in play, no sound). An event without a time ends the running one.
 */
export function reloadFeedback(host: InfHost, ev: Ev<'reload'>, now: number): void {
	const players = avatars(host);
	if (!players) return;
	const ms = infReloadMs(ev);
	if (ms === 0) {
		players.stopReload(ev.id);
		return;
	}
	players.reload(ev.id, ev.weapon, now, ms);
	if (players.pose(ev.id, AV)) host.sound('reload', { x: AV.x, y: AV.y, z: AV.z + BODY_SOUND_Z });
}

/** A mode state: players who are down or no longer play (spectating) reload nothing. */
export function syncReloads(players: RemotePlayers | null, state: InfStateView): void {
	players?.stopReloads((id) => state.players.some((p) => p.id === id && p.alive));
}

/**
 * Every frame: what each remote player holds, from the mode state (the
 * weapon, claws for an infected; Patient Zero of an older server may hold a
 * gun), and the throwing knife.
 */
export function syncHeld(players: RemotePlayers | null, state: InfStateView | null, me: number): void {
	if (!players || !state) return;
	for (const p of state.players) {
		if (p.id === me) continue;
		players.setHeld(p.id, p.team === 'infected' && !p.alpha ? 'claws' : p.weapon, p.team === 'infected' && p.hasKnife);
	}
}
