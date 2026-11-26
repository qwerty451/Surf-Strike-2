/** Pure helpers for the Zombies client and HUD (docs/modes.md#zombies). Unit-tested. */
import { weaponForSlot, WEAPONS, WEAPON_IDS, type Vec3, type WeaponId } from '@surf/shared';
import type { KillFeedLine } from './contract.js';

export const KILL_FEED_MAX = 5;
export const KILL_FEED_MS = 6000;
/** A semi-auto click is remembered this long if the weapon is not ready yet. */
export const FIRE_BUFFER_MS = 150;

/** Keys 1-4: pick a weapon while the loadout window is open (null = nothing to do). */
export function slotAction(slot: number, loadoutOpen: boolean): { kind: 'weapon'; weapon: WeaponId } | null {
	const w = weaponForSlot(slot);
	return w && loadoutOpen ? { kind: 'weapon', weapon: w } : null;
}

/** Loadout choices in key order. */
export function loadoutChoices(): Array<{ slot: number; weapon: WeaponId; label: string; speed: number; hits: string }> {
	return [...WEAPON_IDS]
		.sort((a, b) => WEAPONS[a].slot - WEAPONS[b].slot)
		.map((w) => {
			const d = WEAPONS[w];
			const hits = Math.ceil(8 / d.damage);
			return { slot: d.slot, weapon: w, label: d.label, speed: d.moveSpeed, hits: hits === 1 ? '1 hit' : `${hits} hits` };
		});
}

/** Ammo readout: magazine and reserve, or a dash for melee. */
export function ammoText(mag: number, magSize: number, reserve: number): { mag: string; reserve: string; low: boolean } {
	if (magSize <= 0) return { mag: '—', reserve: '', low: false };
	return { mag: String(mag), reserve: String(reserve), low: mag <= Math.max(1, Math.floor(magSize * 0.2)) };
}

/** Reload progress 0..1 (1 when not reloading). */
export function reloadProgress(now: number, endsAt: number, ms: number): number {
	if (endsAt <= 0 || ms <= 0 || now >= endsAt) return 1;
	return Math.max(0, Math.min(1, 1 - (endsAt - now) / ms));
}

/** New kill feed with `line` on top, at most KILL_FEED_MAX lines younger than KILL_FEED_MS. */
export function pushKillFeed(feed: readonly KillFeedLine[], line: KillFeedLine, now: number): KillFeedLine[] {
	return [line, ...feed.filter((l) => now - l.at < KILL_FEED_MS)].slice(0, KILL_FEED_MAX);
}

/** Kill feed lines still young enough to show. */
export function liveKillFeed(feed: readonly KillFeedLine[], now: number): KillFeedLine[] {
	return feed.filter((l) => now - l.at < KILL_FEED_MS);
}

/** Source forward vector for view angles (pitch + = down). */
export function forwardDir(pitch: number, yaw: number): Vec3 {
	const p = (pitch * Math.PI) / 180;
	const y = (yaw * Math.PI) / 180;
	return { x: Math.cos(p) * Math.cos(y), y: Math.cos(p) * Math.sin(y), z: -Math.sin(p) };
}

/** `dir` turned by a random angle up to `deg` (uniform over the cone's disc). */
export function spreadDir(dir: Vec3, deg: number, rng: () => number = Math.random): Vec3 {
	if (deg <= 0) return { ...dir };
	// Orthonormal basis around dir.
	const up = Math.abs(dir.z) < 0.99 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
	let rx = dir.y * up.z - dir.z * up.y;
	let ry = dir.z * up.x - dir.x * up.z;
	let rz = dir.x * up.y - dir.y * up.x;
	const rl = Math.hypot(rx, ry, rz);
	rx /= rl;
	ry /= rl;
	rz /= rl;
	const ux = ry * dir.z - rz * dir.y;
	const uy = rz * dir.x - rx * dir.z;
	const uz = rx * dir.y - ry * dir.x;
	const a = rng() * Math.PI * 2;
	const r = Math.tan((deg * Math.PI) / 180) * Math.sqrt(rng());
	const ox = dir.x + (rx * Math.cos(a) + ux * Math.sin(a)) * r;
	const oy = dir.y + (ry * Math.cos(a) + uy * Math.sin(a)) * r;
	const oz = dir.z + (rz * Math.cos(a) + uz * Math.sin(a)) * r;
	const l = Math.hypot(ox, oy, oz);
	return { x: ox / l, y: oy / l, z: oz / l };
}

/** m:ss for round clocks. */
export function formatRoundClock(secs: number): string {
	const s = Math.max(0, Math.floor(secs));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
