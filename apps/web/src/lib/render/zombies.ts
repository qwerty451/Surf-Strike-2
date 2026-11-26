/**
 * Zombies visuals (docs/modes.md#zombies): zombies (the character model of
 * docs/characters.md, hunched, greenish grey, glowing eyes), hit flash, death collapse
 * and fade (no blood), tracers, and first-person viewmodels with a muzzle
 * flash drawn in their own scene over the world. Positions are Source feet
 * origins; Source → Three is (x, y, z) → (x, z, −y).
 */
import type { GateState, WeaponId, ZombieGate } from '@surf/shared';
import { ZF_ATTACKING, ZF_HIT, ZF_ON_GROUND } from '@surf/shared';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ease, GunKick, VM_AIM_STEADY, vmKick, type VmFeel } from '../game/gunfeel.js';
import { emptyMotion, type MotionState } from './character/animator.js';
import type { CrowdView } from './character/crowd.js';
import type { HeldAssets } from './character/held.js';
import { caseOf, Casings, depthScale, reducedMotion, type HandOver } from './casings.js';
import { CharacterModel, personOf } from './character/model.js';
import { FpAnim, isGun, VM_SCALE, type FpInput } from './fp-anim.js';
import { VelocityTracker } from './character/motion.js';
import { hasFlash, MuzzleFx } from './muzzle-flash.js';
import { aimDepthOf, sightOf } from './sights.js';
import type { GunRig } from './gun-rig.js';
import type { WeaponHandPair } from './hands.js';
import { buildViewmodels, type ClawPose, type Viewmodels } from './viewmodels.js';
import { defaultLoad, generated, lightFirstPerson, meshesOf, ModelCache, type ModelLoad } from './weapon-assets.js';

const DEG = Math.PI / 180;
const CORPSE_FALL_MS = 380;
const CORPSE_FADE_MS = 1300;
const TRACER_MS = 90;
/** Claw slash and throwing-knife throw animation lengths. */
export const SLASH_MS = 320;
export const THROW_MS = 360;
/** The off-hand knife leaves the hand this far into the throw (0..1). */
export const RELEASE_AT = 0.38;
/** Pop-in time when the off-hand knife comes back (pickup, respawn). */
const OFFHAND_POP_MS = 140;
/** The gun that is swapped away is out of the picture after this long (ms). */
const AWAY_MS = 130;
/** The slashing claw is fully across the view this far into the slash (0..1); the rest is the way back. */
const SLASH_REACH = 0.3;
/** Throw: the wind-up ends and the cast is fully forward this far into it (0..1). */
const THROW_WIND = 0.16;
const THROW_CAST = 0.44;
/** After the release the left fist opens into a claw over this long (ms). */
const OPEN_MS = 140;
/** Tracer pool: several shotgun volleys (one tracer per pellet) fit inside one TRACER_MS. */
export const MAX_TRACERS = 96;

/**
 * Viewmodel push-back per weapon (the visual recoil): length of the whole
 * push and of its attack (ms) and how far the gun moves back (viewmodel
 * units). The curve is `vmKick` (game/gunfeel.ts): a fast attack, then a damped
 * return. The gun's rotation is the gun kick (`GunKick`, `GUN_KICK` in
 * game/gunfeel.ts), a velocity model of its own.
 */
export const VM_KICK: Readonly<Partial<Record<WeaponId, { ms: number; attack: number; back: number }>>> = Object.freeze({
	pistol: { ms: 130, attack: 14, back: 1.1 },
	lmg: { ms: 200, attack: 18, back: 1.4 },
	sniper: { ms: 260, attack: 22, back: 2.4 },
	barrett: { ms: 300, attack: 24, back: 3.4 },
	striker: { ms: 220, attack: 20, back: 2.6 },
	smg: { ms: 100, attack: 12, back: 0.7 }
});
const DEFAULT_KICK = { ms: 130, attack: 14, back: 1.1 };
/** Sight point of the held gun and the aimed gun-kick turn about the eye, reused every frame. */
const SIGHT = new THREE.Vector3();
const PIVOT = new THREE.Euler();
/** Share of the push-back taken away when fully aimed. */
const VM_AIM_PUSH = 0.6;

const FLASH = new THREE.Color(0xffffff);
const NO_GLOW = new THREE.Color(0x000000);
const ATTACK_GLOW = new THREE.Color(0x3a0a00);

export interface ZombiePose {
	id: number;
	x: number;
	y: number;
	z: number;
	yaw: number;
	flags: number;
	/** Model scale about the feet (Zombie Defense kinds); 1 when absent. */
	scale?: number;
	/** Colour multiplied into the model (Zombie Defense kinds); white when absent. */
	tint?: number;
	/** Glow added to the model when not hit or attacking (the boss, frosted zombies). */
	glow?: number;
}

const WHITE = 0xffffff;
const TINT = new THREE.Color();

interface ZombieMesh {
	root: THREE.Group;
	body: THREE.Group;
	model: CharacterModel;
	motion: MotionState;
	velocity: VelocityTracker;
	/** Local hit flash until (ms). */
	flashUntil: number;
	/** Source feet position of this frame. */
	x: number;
	y: number;
	z: number;
}

interface Corpse {
	m: ZombieMesh;
	at: number;
	dir: number;
}

interface Tracer {
	line: THREE.Line;
	at: number;
}

export class ZombieRenderer {
	readonly group = new THREE.Group();
	/** Viewmodel scene and camera, rendered after the world with a cleared depth buffer. */
	readonly vmScene = new THREE.Scene();
	readonly vmCamera = new THREE.PerspectiveCamera(62, 16 / 9, 0.5, 200);
	private box = new THREE.BoxGeometry(1, 1, 1);
	private made = 1;
	private live = new Map<number, ZombieMesh>();
	private free: ZombieMesh[] = [];
	private corpses: Corpse[] = [];
	private tracers: Tracer[] = [];
	private tracerMat = new THREE.LineBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
	private seen = new Set<number>();
	// Viewmodel
	private vm = new THREE.Group();
	private guns = new Map<WeaponId, THREE.Group>();
	private readonly muzzle: MuzzleFx;
	private weapon: WeaponId | null = null;
	private kickAt = -Infinity;
	/** Push-back level the last shot started from (a new shot does not snap back to rest). */
	private kickFrom = 0;
	/** Gun kick: the held gun's rotation from its shots. */
	private readonly gunKick = new GunKick();
	/** Cycling, reloads and the bolt of the held gun (render/fp-anim.ts). */
	readonly anim = new FpAnim();
	private throwAt = -Infinity;
	/** Infected: throwing knife held ready in the left claw. */
	private offhand = false;
	private offhandAt = -Infinity;
	private offKnife: THREE.Group | null = null;
	vmVisible = false;
	/** First-person models: the code-built set, and the generated models that replace them once loaded. */
	private set: Viewmodels;
	private models: ModelCache;
	/** Room environment of the generated models (made once a renderer is given). */
	private gl: THREE.WebGLRenderer | null = null;
	private env: THREE.WebGLRenderTarget | null = null;
	private vmMats: THREE.Material[] = [];
	/** Spent cases of my gun and the others'. */
	readonly casings = new Casings();
	/** My shots whose case is not out yet, and where the port of the held gun was when it was last seen from the hip. */
	private toEject = 0;
	private readonly port = new THREE.Vector3(4.6, -3.2, -13);
	private readonly portDir = new THREE.Vector3(1, 0, 0);
	private portScale = VM_SCALE;
	private portOf: WeaponId | null = null;
	private portRig: GunRig | undefined;
	private readonly fpInput: FpInput = { reload: 1, mag: undefined, dry: 0, aim: 0, lower: 0 };
	/** Viewmodel geometry, disposed with the renderer. */
	private vmGeoms: THREE.BufferGeometry[] = [];
	// Gates: glowing barrier boxes and unlock-area floor markers.
	private gates: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; area: THREE.Mesh; areaMat: THREE.MeshBasicMaterial; state: GateState; at: number }> = [];

	/** `load`: how generated models are fetched (render/weapon-assets.ts); the tests pass their own. */
	constructor(
		private readonly assets: HeldAssets,
		load: ModelLoad = defaultLoad
	) {
		this.group.name = 'zombies';
		this.vmScene.add(new THREE.HemisphereLight(0xd8d4e8, 0x3a3030, 1.6));
		const sun = new THREE.DirectionalLight(0xffc8a0, 1.4);
		sun.position.set(0.5, 1, 0.6);
		this.vmScene.add(sun, this.vm, this.away, this.casings.hand);
		this.group.add(this.casings.world);
		// First-person models (render/viewmodels.ts): one hidden group per weapon id.
		const set = (this.set = buildViewmodels());
		this.models = new ModelCache(load, (id, model) => this.fitModel(id, model), (kit) => set.useHands(kit));
		this.vmMats.push(...set.materials);
		this.vmGeoms = set.geometries;
		this.offKnife = set.offKnife;
		for (const [id, g] of set.models) {
			this.guns.set(id, g);
			this.vm.add(g);
		}
		this.muzzle = new MuzzleFx(reducedMotion());
		this.vm.add(this.muzzle.mesh);
		this.vmScene.add(this.muzzle.scene);
	}

	// ---------------------------------------------------------------------
	// Zombies

	private create(): ZombieMesh {
		const model = new CharacterModel(personOf(this.made++), this.assets);
		model.setRole('zombie');
		const body = new THREE.Group();
		body.add(model.group);
		const root = new THREE.Group();
		root.add(body);
		this.group.add(root);
		return { root, body, model, motion: emptyMotion(), velocity: new VelocityTracker(), flashUntil: 0, x: 0, y: 0, z: 0 };
	}

	private take(): ZombieMesh {
		const m = this.free.pop() ?? this.create();
		m.root.visible = true;
		m.body.rotation.set(0, 0, 0);
		m.body.position.set(0, 0, 0);
		const mat = m.model.material;
		mat.opacity = 1;
		if (mat.transparent) {
			mat.transparent = false;
			mat.needsUpdate = true;
		}
		mat.emissive.copy(NO_GLOW);
		mat.color.setHex(WHITE);
		m.root.scale.setScalar(1);
		Object.assign(m.motion, emptyMotion());
		m.velocity.reset();
		m.model.animator.reset();
		return m;
	}

	private release(m: ZombieMesh): void {
		m.root.visible = false;
		this.free.push(m);
	}

	/** Draw the zombies of this frame (ids not listed are removed). */
	sync(list: readonly ZombiePose[], now: number): void {
		this.seen.clear();
		for (const z of list) {
			this.seen.add(z.id);
			let m = this.live.get(z.id);
			if (!m) {
				m = this.take();
				this.live.set(z.id, m);
			}
			m.root.position.set(z.x, z.z, -z.y);
			m.root.scale.setScalar(z.scale ?? 1);
			m.model.material.color.setHex(z.tint ?? WHITE);
			m.x = z.x;
			m.y = z.y;
			m.z = z.z;
			m.motion.yaw = z.yaw;
			m.motion.onGround = (z.flags & ZF_ON_GROUND) !== 0;
			const attacking = (z.flags & ZF_ATTACKING) !== 0;
			m.model.animator.lunging = attacking;
			const hit = (z.flags & ZF_HIT) !== 0 || now < m.flashUntil;
			if (hit) m.model.material.emissive.copy(FLASH).multiplyScalar(0.55);
			else if (attacking) m.model.material.emissive.copy(ATTACK_GLOW);
			else if (z.glow !== undefined) m.model.material.emissive.copy(TINT.setHex(z.glow));
			else m.model.material.emissive.copy(NO_GLOW);
		}
		for (const [id, m] of this.live) {
			if (this.seen.has(id)) continue;
			this.live.delete(id);
			this.release(m);
		}
	}

	/** Animate the live zombies (once per frame, before rendering). */
	animate(view: CrowdView): void {
		for (const m of this.live.values()) {
			m.velocity.push(m.x, m.y, m.z, view.dt, m.motion);
			const dist = view.distance(m.root.position);
			if (dist < 0) m.model.skipFrame(view.dt, m.motion);
			else m.model.update(view.dt, m.motion, dist);
		}
	}

	/** Local hit feedback before the next snapshot shows the flag. */
	flash(id: number, now: number): void {
		const m = this.live.get(id);
		if (m) m.flashUntil = now + 120;
	}

	/** Death: the zombie collapses and fades. Uses its live mesh, or a pose when it is gone. */
	kill(id: number, pose: ZombiePose | null, now: number): void {
		let m = this.live.get(id);
		if (m) this.live.delete(id);
		else if (pose) {
			m = this.take();
			m.root.position.set(pose.x, pose.z, -pose.y);
			m.root.scale.setScalar(pose.scale ?? 1);
			m.model.material.color.setHex(pose.tint ?? WHITE);
			m.motion.yaw = pose.yaw;
			m.model.update(0, m.motion, 0);
		} else return;
		const mat = m.model.material;
		mat.transparent = true;
		mat.needsUpdate = true;
		mat.emissive.copy(NO_GLOW);
		// The fall turns around the facing: move the yaw out to the body.
		m.model.setYaw(0);
		m.body.rotation.y = m.motion.yaw * DEG;
		this.corpses.push({ m, at: now, dir: Math.random() < 0.5 ? 1 : -1 });
	}

	// ---------------------------------------------------------------------
	// Gates

	/** Build the gate meshes of a zombies map (closed). */
	setGates(gates: readonly ZombieGate[], now: number): void {
		this.clearGates();
		for (const g of gates) {
			const mat = new THREE.MeshBasicMaterial({ color: 0xff9a2a, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
			const mesh = new THREE.Mesh(this.box, mat);
			const sx = g.max.x - g.min.x;
			const sy = g.max.y - g.min.y;
			const sz = g.max.z - g.min.z;
			mesh.scale.set(sx, sz, sy);
			mesh.position.set((g.min.x + g.max.x) / 2, (g.min.z + g.max.z) / 2, -(g.min.y + g.max.y) / 2);
			mesh.renderOrder = 3;
			const edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.box), new THREE.LineBasicMaterial({ color: 0xffd080 }));
			mesh.add(edges);
			const u = g.unlock;
			const areaMat = new THREE.MeshBasicMaterial({ color: 0x5cff9a, transparent: true, opacity: 0.16, depthWrite: false });
			const area = new THREE.Mesh(this.box, areaMat);
			area.scale.set(u.max.x - u.min.x, 1, u.max.y - u.min.y);
			area.position.set((u.min.x + u.max.x) / 2, u.min.z + 1, -(u.min.y + u.max.y) / 2);
			this.group.add(mesh, area);
			this.gates.push({ mesh, mat, area, areaMat, state: 'closed', at: now });
		}
	}

	setGateState(i: number, state: GateState, now: number): void {
		const g = this.gates[i];
		if (!g || g.state === state) return;
		g.state = state;
		g.at = now;
		if (state === 'closed') {
			g.mesh.visible = true;
			g.mesh.scale.y = Math.abs(g.mesh.scale.y);
			g.mat.opacity = 0.55;
		}
	}

	private updateGates(now: number): void {
		for (const g of this.gates) {
			const t = now - g.at;
			g.area.visible = g.state === 'closed';
			if (g.state === 'open') {
				// Fade out and sink over 0.9 s.
				const f = Math.min(1, t / 900);
				g.mat.opacity = 0.55 * (1 - f);
				g.mesh.visible = f < 1;
			} else {
				const pulse = g.state === 'counting' ? 0.5 + 0.5 * Math.sin(t / 120) : 0.5 + 0.5 * Math.sin(now / 600);
				g.mat.color.setHex(g.state === 'counting' ? 0xffd24a : 0xff9a2a);
				g.mat.opacity = 0.4 + 0.25 * pulse;
				g.areaMat.opacity = 0.1 + 0.1 * pulse;
			}
		}
	}

	private clearGates(): void {
		for (const g of this.gates) {
			g.mesh.removeFromParent();
			g.area.removeFromParent();
			g.mat.dispose();
			g.areaMat.dispose();
			for (const c of g.mesh.children) {
				(c as THREE.LineSegments).geometry.dispose();
				((c as THREE.LineSegments).material as THREE.Material).dispose();
			}
		}
		this.gates = [];
	}

	// ---------------------------------------------------------------------
	// Tracers

	/** Cosmetic tracer between two Source points. */
	tracer(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, now: number): void {
		// An expired tracer, else a new one, else (pool full) the oldest.
		let tr: Tracer | undefined;
		let oldest: Tracer | undefined;
		for (const t of this.tracers) {
			if (now - t.at > TRACER_MS) {
				tr = t;
				break;
			}
			if (!oldest || t.at < oldest.at) oldest = t;
		}
		if (!tr) {
			if (this.tracers.length >= MAX_TRACERS) tr = oldest!;
			else {
				const g = new THREE.BufferGeometry();
				g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
				const line = new THREE.Line(g, this.tracerMat.clone());
				line.frustumCulled = false;
				this.group.add(line);
				tr = { line, at: now };
				this.tracers.push(tr);
			}
		}
		const pos = tr.line.geometry.getAttribute('position') as THREE.BufferAttribute;
		pos.setXYZ(0, from.x, from.z, -from.y);
		pos.setXYZ(1, to.x, to.z, -to.y);
		pos.needsUpdate = true;
		tr.at = now;
		tr.line.visible = true;
	}

	// ---------------------------------------------------------------------
	// Viewmodel

	setWeapon(w: WeaponId | null): void {
		if (w === this.weapon) return;
		this.putAway(w);
		// The generated model of a weapon is fetched when it is first held; the code-built one shows until then.
		this.models.request(w);
		this.weapon = w;
		// The new weapon starts at rest: no kick or slash carried over from the old one.
		this.kickAt = -Infinity;
		this.kickFrom = 0;
		this.gunKick.reset();
		this.anim.hold(w);
		this.muzzle.hold(hasFlash(w) ? w : null);
		this.toEject = 0;
		for (const [id, g] of this.guns) g.visible = id === w || id === this.awayId;
		// Its moving parts and its hands too: no half-open bolt from an interrupted reload.
		if (w) this.set.rest(w);
	}

	/** The gun just swapped away, as it was (a reload half done too), on its way down out of the picture. */
	private readonly away = new THREE.Group();
	private awayId: WeaponId | null = null;
	private awayAt = -Infinity;

	/** `next` is taken up: what is held now goes down, if it is drawn and something comes in its place. */
	private putAway(next: WeaponId | null): void {
		this.backHome();
		const g = this.weapon ? this.guns.get(this.weapon) : undefined;
		if (!g || !next || !this.vmVisible || !isGun(this.weapon)) return;
		this.awayId = this.weapon;
		this.awayAt = -Infinity;
		this.away.position.copy(this.vm.position);
		this.away.rotation.copy(this.vm.rotation);
		this.away.scale.copy(this.vm.scale);
		this.away.add(g);
		this.sunk = 0;
	}

	/** The gun that was going down is out of the picture: its parts and hands at rest, hidden. */
	private backHome(): void {
		const id = this.awayId;
		if (!id) return;
		this.awayId = null;
		const g = this.guns.get(id)!;
		this.vm.add(g);
		g.visible = this.weapon === id;
		this.set.rest(id);
	}

	/** Frame: only a swap with a draw shows the old gun go (`lower`: how far the new one is still down). */
	private sink(now: number, lower: number): void {
		if (!this.awayId) return;
		if (this.awayAt === -Infinity) {
			if (!(lower > 0.2)) return this.backHome();
			this.awayAt = now;
		}
		const u = (now - this.awayAt) / AWAY_MS;
		if (!(u >= 0) || u >= 1) return this.backHome();
		const d = Math.min(1, u - this.sunk);
		this.sunk = u;
		// Faster and faster, muzzle down.
		this.away.position.y -= d * (4 + 24 * u);
		this.away.rotation.x -= d * 0.7;
	}

	private sunk = 0;

	/** The moving parts and points of a loaded gun (render/gun-rig.ts), once its model has arrived. */
	rig(id: WeaponId): GunRig | undefined {
		return this.guns.get(id)?.userData.rig as GunRig | undefined;
	}

	/** The gloved hands of a weapon (render/hands.ts), once its model and the hands have arrived. */
	hands(id: WeaponId): WeaponHandPair | undefined {
		return this.guns.get(id)?.userData.hands as WeaponHandPair | undefined;
	}

	/** Shot or swing: recoil kick, claw slash, and (guns only) a muzzle flash. */
	fired(now: number): void {
		this.kickFrom = this.pushBack(now);
		this.kickAt = now;
		if (this.weapon) this.gunKick.kick(this.weapon, now);
		this.anim.fired(now);
		// The sniper's case stays in until its bolt opens.
		if (this.weapon && caseOf(this.weapon) && this.weapon !== 'sniper') this.toEject++;
		this.muzzle.fired(now);
	}

	/** Push-back level 0..1 of the held gun at `now`. */
	private pushBack(now: number): number {
		const kick = (this.weapon && VM_KICK[this.weapon]) || DEFAULT_KICK;
		return vmKick(now - this.kickAt, kick.attack, kick.ms, this.kickFrom);
	}

	/**
	 * Infected: show the throwing knife held in the left claw. Hiding it right
	 * after `thrown()` keeps it in the hand until the release point of the throw.
	 */
	setOffhandKnife(visible: boolean, now = performance.now()): void {
		if (visible === this.offhand) return;
		this.offhand = visible;
		if (visible) this.offhandAt = now;
	}

	/** Whether the off-hand knife is held (set by `setOffhandKnife`). */
	get offhandKnife(): boolean {
		return this.offhand;
	}

	/** Whether the off-hand knife mesh was drawn in the last `updateViewmodel`. */
	get offhandDrawn(): boolean {
		return !!this.offKnife?.visible && this.vmVisible && this.weapon === 'claws';
	}

	/** Throwing knife: an overhand throw (no muzzle flash). */
	thrown(now: number): void {
		this.throwAt = now;
	}

	/**
	 * Pose the viewmodel for this frame. `reload` 0..1 while reloading, else 1.
	 * `feel` (game/gunfeel.ts) adds the sway, the draw, the landing dip and the
	 * dry-fire nudge; without it the gun rests in place (zombies, hide and seek).
	 * `mag`: rounds in the magazine (an empty gun locks open and reloads with its bolt); left out, the gun never shows empty.
	 */
	updateViewmodel(now: number, visible: boolean, reload: number, speed: number, feel?: VmFeel, mag?: number): void {
		this.vmVisible = visible && this.weapon !== null;
		this.vm.visible = this.vmVisible;
		const g = this.weapon ? this.guns.get(this.weapon) : undefined;
		this.away.visible = this.vmVisible;
		this.sink(now, this.vmVisible ? (feel?.lower ?? 0) : 0);
		// A hidden gun goes on too: the bolt is worked behind the scope.
		const inp = this.fpInput;
		inp.reload = reload;
		inp.mag = mag;
		inp.dry = feel?.dry ?? 0;
		inp.aim = feel?.aim ?? 0;
		inp.lower = feel?.lower ?? 0;
		this.anim.update(now, inp, this.vmVisible ? (g?.userData.rig as GunRig | undefined) : undefined, g?.userData.hands as WeaponHandPair | undefined);
		if (this.anim.events.opened) this.toEject++;
		if (!this.vmVisible) return;
		const kick = (this.weapon && VM_KICK[this.weapon]) || DEFAULT_KICK;
		// Melee: a linear swing. Guns: a fast push-back with a damped return, and the gun kick.
		const k =
			this.weapon === 'knife' || this.weapon === 'claws'
				? Math.max(0, 1 - (now - this.kickAt) / (this.weapon === 'knife' ? 300 : SLASH_MS))
				: this.pushBack(now);
		this.gunKick.update(now);
		const tp = Math.max(0, Math.min(1, (now - this.throwAt) / THROW_MS));
		/** 0 → 1 → 0 over the throw (wind-up, release, recover). */
		const toss = tp < 1 ? Math.sin(tp * Math.PI) : 0;
		// Aiming down sights: the sights come to the view axis, sway and bob shrink (1 at the hip).
		const aim = feel && feel.aim > 0 && this.weapon && sightOf(this.weapon, g, SIGHT) ? Math.min(1, feel.aim) : 0;
		const steady = 1 - VM_AIM_STEADY * aim;
		const bob = Math.min(1, speed / 250) * Math.sin(now / 95) * 0.5 * steady;
		this.vm.scale.setScalar(VM_SCALE);
		this.vm.position.set(5, -4.6 + bob * 0.6, -10);
		this.vm.rotation.set(0, 0, 0);
		if (this.weapon === 'claws' && g) {
			const right = g.userData.right as THREE.Group;
			const left = g.userData.left as THREE.Group;
			const rr = right.userData.rest as ClawPose;
			const lr = left.userData.rest as ClawPose;
			const lh = left.userData.hold as ClawPose;
			// Slash (u 0 → 1): the right claw whips across the middle of the view, palm and talons leading to the
			// left, then dips and comes back slowly.
			const u = 1 - k;
			const reach = u < SLASH_REACH ? 1 - (1 - u / SLASH_REACH) ** 3 : 1 - ease((u - SLASH_REACH) / (1 - SLASH_REACH));
			const arc = u < SLASH_REACH ? Math.sin((u / SLASH_REACH) * Math.PI) : 0;
			const dip = u > SLASH_REACH && u < 1 ? Math.sin(((u - SLASH_REACH) / (1 - SLASH_REACH)) * Math.PI) : 0;
			const idle = Math.sin(now / 420) * 0.4;
			right.position.set(rr.x - reach * 12.9, rr.y + reach * 3.9 + arc * 2 - dip * 3 + idle, rr.z - reach * 5.6);
			right.rotation.set(rr.rx - reach * 0.2, rr.ry + reach * 0.5, rr.rz - reach * 0.95);
			// The knife is in the left fist while held, and until the release point of a throw.
			const held = this.offhand || tp < RELEASE_AT;
			// 1 with the knife in the fist: eases in on a pickup, and out to the open claw after the release.
			const hold = this.offhand ? ease((now - this.offhandAt) / OFFHAND_POP_MS) : tp < RELEASE_AT ? 1 : 1 - ease(((tp - RELEASE_AT) * THROW_MS) / OPEN_MS);
			// Throw: wind up beside the head, whip forward (the release), follow through and come back.
			const wind = tp < THROW_WIND ? ease(tp / THROW_WIND) : 1 - ease((tp - THROW_WIND) / 0.2);
			const cast = tp < THROW_WIND ? 0 : tp < THROW_CAST ? 1 - (1 - (tp - THROW_WIND) / (THROW_CAST - THROW_WIND)) ** 2 : 1 - ease((tp - THROW_CAST) / (1 - THROW_CAST));
			left.position.set(lr.x + (lh.x - lr.x) * hold + wind + cast * 5.2, lr.y + (lh.y - lr.y) * hold + wind * 6.6 + cast * 3.8 - idle, lr.z + (lh.z - lr.z) * hold + wind * 2.8 - cast * 10.3);
			// The hand stays tipped up through the cast: the forearm has to keep running down out of the view.
			left.rotation.set(lr.rx + (lh.rx - lr.rx) * hold + wind * 0.55 - cast * 0.05, lr.ry + (lh.ry - lr.ry) * hold + cast * 0.1, lr.rz + (lh.rz - lr.rz) * hold);
			(left.userData.fist as THREE.Object3D).visible = held;
			(left.userData.open as THREE.Object3D).visible = !held;
			const off = this.offKnife;
			if (off) {
				off.visible = held;
				const pop = Math.min(1, Math.max(0, (now - this.offhandAt) / OFFHAND_POP_MS));
				off.scale.setScalar(this.offhand ? 0.35 + 0.65 * (1 - (1 - pop) * (1 - pop)) : 1);
			}
		} else if (this.weapon === 'knife') {
			this.vm.rotation.x = -k * 0.9;
			this.vm.rotation.y = k * 0.6;
			this.vm.position.x = 5 - k * 3;
		} else {
			// Shot: pushed back along the barrel; the gun kick turns the muzzle up and sideways. Reload and
			// bolt: the gun goes with the clip (render/fp-clips.ts), its underside turned to the left hand.
			const gk = feel?.gun ?? this.gunKick;
			const o = this.anim.gun;
			this.vm.position.x += o[0]!;
			this.vm.position.y += o[1]!;
			// Aimed, the push-back is smaller: the sights stay in front of the eye.
			this.vm.position.z = -10 + k * kick.back * (1 - VM_AIM_PUSH * aim) + o[2]!;
			this.vm.rotation.x = gk.pitch * DEG + o[3]!;
			this.vm.rotation.y = gk.yaw * DEG + o[4]!;
			this.vm.rotation.z = o[5]!;
		}
		if (toss > 0 && this.weapon !== 'claws') {
			this.vm.position.y -= toss * 3;
			this.vm.rotation.x -= toss * 0.8;
		}
		if (feel) {
			// Sway and landing dip; the dry-fire nudge; lowered muzzle-down by the draw and the scope.
			this.vm.position.x += feel.x * steady;
			this.vm.position.y += feel.y * steady - feel.land * 1.4 - feel.lower * 11;
			this.vm.position.z += feel.dry * 0.35;
			this.vm.rotation.x += feel.pitch * steady - feel.dry * 0.05 - feel.lower * 0.7;
			this.vm.rotation.y += feel.yaw * steady;
			this.vm.rotation.z += feel.roll * steady + feel.lower * 0.3;
		}
		if (aim > 0) {
			// From the hip pose to the aimed one: the sight point (render/sights.ts) on the view axis, the aim depth ahead.
			const s = this.vm.scale.x;
			this.vm.position.x += (-s * SIGHT.x - 5) * aim;
			this.vm.position.y += (-s * SIGHT.y + 4.6) * aim;
			this.vm.position.z += (-aimDepthOf(this.weapon!, g) - s * SIGHT.z + 10) * aim;
			// Aimed, the gun kick turns the gun about the eye, so the sights point where the kick turned the shot.
			const gk = feel?.gun ?? this.gunKick;
			if (gk.pitch !== 0 || gk.yaw !== 0) this.vm.position.applyEuler(PIVOT.set(gk.pitch * DEG * aim, gk.yaw * DEG * aim, 0));
		}
		// Once from the hip, for a case that comes out behind the scope, and for every case that comes out now.
		const loaded = g?.userData.rig as GunRig | undefined;
		if (this.toEject > 0 || (aim < 0.1 && (this.portOf !== this.weapon || this.portRig !== loaded))) {
			this.findPort(g);
			this.portOf = this.weapon;
			this.portRig = loaded;
		}
		this.muzzle.update(now, (g?.userData.muzzle as THREE.Vector3 | null | undefined) ?? null, this.vm, aim);
	}

	/**
	 * Where the muzzle of the held gun was last drawn: right of and below the screen centre, in half screen
	 * heights, into `out`. False without a gun on screen.
	 */
	muzzleScreen(out: { right: number; down: number }): boolean {
		const m = this.weapon && this.vmVisible ? (this.guns.get(this.weapon)?.userData.muzzle as THREE.Vector3 | null | undefined) : null;
		if (!m) return false;
		this.vm.updateMatrixWorld(true);
		const v = this.muzzleV.copy(m).applyMatrix4(this.vm.matrixWorld);
		if (v.z > -0.1) return false;
		const k = 1 / (-v.z * Math.tan((this.vmCamera.fov * Math.PI) / 360));
		out.right = v.x * k;
		out.down = -v.y * k;
		return true;
	}

	private readonly muzzleV = new THREE.Vector3();

	/** Where the ejection port of the held gun is in the view of the viewmodel camera, and the way out of it. */
	private findPort(g: THREE.Group | undefined): void {
		if (!g || !g.userData.muzzle) return;
		this.vm.updateMatrixWorld(true);
		const node = (g.userData.rig as GunRig | undefined)?.point('eject');
		this.portScale = this.vm.scale.x * ((g.userData.hands as WeaponHandPair | undefined)?.space.scale.x ?? 1);
		if (node) {
			this.port.setFromMatrixPosition(node.matrixWorld);
			this.portDir.setFromMatrixColumn(node.matrixWorld, 0).normalize();
		} else {
			// A code-built gun: a third of the way to the muzzle, on its right.
			const m = g.userData.muzzle as THREE.Vector3;
			this.port.set(m.x + 1.2, m.y, m.z * 0.35).applyMatrix4(this.vm.matrixWorld);
			this.portDir.set(1, 0, 0).transformDirection(this.vm.matrixWorld);
		}
	}

	/** Cases out and on their way; `camera`: the world camera of this frame, placed. Once per frame, before rendering. */
	updateCasings(now: number, camera: THREE.PerspectiveCamera): void {
		camera.updateMatrixWorld();
		const h = this.handOver;
		h.vmTan = Math.tan((this.vmCamera.fov * Math.PI) / 360);
		h.worldTan = Math.tan((camera.fov * Math.PI) / 360);
		h.k = depthScale(this.portScale);
		const def = this.weapon ? caseOf(this.weapon) : null;
		for (; this.toEject > 0; this.toEject--) if (def) this.casings.eject(def, this.port, this.portDir, camera, h, now, this.fpInput.aim);
		this.casings.update(now, camera, h.vmTan);
	}

	private readonly handOver: HandOver = { k: 1, vmTan: 1, worldTan: 1 };

	/** A generated model arrived: it takes the place of the code-built one at once (the pose is on the viewmodel node). */
	private fitModel(id: WeaponId, model: THREE.Object3D): void {
		// Every part shares one material.
		lightFirstPerson(meshesOf(model)[0]!.material as THREE.Material, this.envMap(), generated(id));
		this.set.fit(id, model);
	}

	/** The renderer that draws the viewmodel: the generated models reflect a room environment made with it. */
	useRenderer(gl: THREE.WebGLRenderer): void {
		this.gl = gl;
	}

	private envMap(): THREE.Texture | null {
		if (!this.env && this.gl) {
			const pm = new THREE.PMREMGenerator(this.gl);
			const room = new RoomEnvironment();
			this.env = pm.fromScene(room, 0.04);
			room.dispose();
			pm.dispose();
		}
		return this.env?.texture ?? null;
	}

	/** Fetch the generated models of these weapons; resolves when every fetch so far has finished (dev viewer). */
	preload(ids: readonly WeaponId[]): Promise<void> {
		for (const id of ids) this.models.request(id);
		return this.models.settled();
	}

	/** Whether the held weapon shows its generated model. */
	generatedShown(id: WeaponId): boolean {
		return !!this.guns.get(id)?.userData.generated;
	}

	resize(aspect: number): void {
		this.vmCamera.aspect = aspect;
		this.vmCamera.updateProjectionMatrix();
	}

	// ---------------------------------------------------------------------

	/** Corpse and tracer animation. */
	update(now: number): void {
		this.updateGates(now);
		for (let i = this.corpses.length - 1; i >= 0; i--) {
			const c = this.corpses[i]!;
			const t = now - c.at;
			const fall = Math.min(1, t / CORPSE_FALL_MS);
			const ease = fall * fall;
			c.m.body.rotation.z = c.dir * ease * (Math.PI / 2) * 0.95;
			c.m.body.position.y = -ease * 4;
			const fade = Math.max(0, Math.min(1, (t - CORPSE_FALL_MS) / CORPSE_FADE_MS));
			c.m.model.material.opacity = 1 - fade;
			if (fade >= 1) {
				this.corpses.splice(i, 1);
				this.release(c.m);
			}
		}
		for (const tr of this.tracers) {
			const age = now - tr.at;
			tr.line.visible = age < TRACER_MS;
			if (tr.line.visible) (tr.line.material as THREE.LineBasicMaterial).opacity = 0.9 * (1 - age / TRACER_MS);
		}
	}

	/** Last drawn pose of a live zombie (for corpses and local tracers). */
	has(id: number): boolean {
		return this.live.has(id);
	}

	clear(): void {
		for (const m of this.live.values()) this.release(m);
		this.live.clear();
		for (const c of this.corpses) this.release(c.m);
		this.corpses = [];
		for (const t of this.tracers) t.line.visible = false;
		this.casings.clear();
		this.toEject = 0;
		this.backHome();
		this.setWeapon(null);
		this.setOffhandKnife(false);
		this.throwAt = -Infinity;
		if (this.offKnife) this.offKnife.visible = false;
		this.vmVisible = false;
	}

	/** Map unload: also drop the gates. */
	reset(): void {
		this.clear();
		this.clearGates();
	}

	dispose(): void {
		this.reset();
		for (const m of this.free) m.model.dispose();
		this.free = [];
		for (const t of this.tracers) {
			t.line.geometry.dispose();
			(t.line.material as THREE.Material).dispose();
		}
		this.tracerMat.dispose();
		for (const m of this.vmMats) m.dispose();
		for (const g of this.vmGeoms) g.dispose();
		this.vmGeoms = [];
		this.models.dispose();
		this.casings.dispose();
		this.env?.dispose();
		this.env = null;
		this.muzzle.dispose();
		this.box.dispose();
		this.group.removeFromParent();
	}
}
