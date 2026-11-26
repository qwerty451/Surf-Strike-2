/**
 * Tournament damage (docs/modes.md#tournament): what one hit of a duel weapon
 * takes off a duelist's 100 HP, by the body region the hit capsule belongs to.
 *
 * | Weapon | Head | Torso (neck to hips) | Arms (and hands) | Legs (and feet) |
 * | ------ | ---- | -------------------- | ---------------- | --------------- |
 * | Sniper | 100  | 100                  | 50               | 50              |
 * | Pistol | 100  | 25                   | 25               | 25              |
 * | Knife  | 50   | 50                   | 50               | 50              |
 *
 * So the sniper kills with one shot on the head or the body and needs two on a
 * limb, the pistol kills with one headshot and four other hits, and the knife
 * always needs two.
 */
import type { PlayerPart } from '../zombies/hitbox.ts';
import type { WeaponId } from '../zombies/weapons.ts';

/** A duelist's health at every round start. */
export const TRN_HP = 100;

export type TrnRegion = 'head' | 'torso' | 'arm' | 'leg';
export type TrnWeapon = 'sniper' | 'pistol' | 'knife';

export const TRN_DAMAGE: Readonly<Record<TrnWeapon, Readonly<Record<TrnRegion, number>>>> = Object.freeze({
	sniper: Object.freeze({ head: 100, torso: 100, arm: 50, leg: 50 }),
	pistol: Object.freeze({ head: 100, torso: 25, arm: 25, leg: 25 }),
	knife: Object.freeze({ head: 50, torso: 50, arm: 50, leg: 50 })
});

/** Region of a hit capsule: the neck counts as torso, hands as arms, feet as legs. */
export function trnRegion(part: PlayerPart): TrnRegion {
	if (part === 'head') return 'head';
	if (part === 'neck' || part === 'chest' || part === 'ribs' || part === 'belly' || part === 'hips') return 'torso';
	if (part.startsWith('upperArm') || part.startsWith('foreArm') || part.startsWith('hand')) return 'arm';
	return 'leg';
}

export const isTrnWeapon = (w: unknown): w is TrnWeapon => w === 'sniper' || w === 'pistol' || w === 'knife';

/** HP one hit of `weapon` on `part` takes off; 0 for a weapon the tournament does not hand out. */
export function trnDamage(weapon: WeaponId, part: PlayerPart): number {
	return isTrnWeapon(weapon) ? TRN_DAMAGE[weapon][trnRegion(part)] : 0;
}

/** Hits of `weapon` on `part` that drop a duelist from full health. */
export function trnHitsToKill(weapon: WeaponId, part: PlayerPart): number {
	const d = trnDamage(weapon, part);
	return d > 0 ? Math.ceil(TRN_HP / d) : Infinity;
}
