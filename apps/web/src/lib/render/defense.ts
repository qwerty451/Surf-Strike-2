/**
 * Zombie Defense visuals (docs/modes.md#zombie-defense, docs/ui.md#zombie-defense-hud):
 * barricade planks per opening (count label, planks that fly off when torn
 * and pop in when put back, metal straps for the "Reinforced" levels, a red
 * frame when broken), turret pads (empty ones glow in the build phase),
 * turrets per type with three visible levels that aim at their targets,
 * muzzle flashes, mortar shells and their explosions, tesla arcs and the
 * frost aura. Zombies and tracers stay in ZombieRenderer. Positions are
 * Source coordinates; Source → Three is (x, y, z) → (x, z, −y), and a Source
 * yaw is a turn of `yaw·DEG` about Three's y axis.
 */
import {
	ZD_TURRET_HEIGHT,
	ZD_TURRETS,
	ZDT_ACTIVE,
	type DefenseMapInfo,
	type ZdOpeningView,
	type ZdPadView,
	type ZdPhase,
	type ZdTurretNet,
	type ZdTurretType
} from '@surf/shared';
import * as THREE from 'three';

const DEG = Math.PI / 180;
const FLASH_MS = 60;
const DEBRIS_MS = 1100;
const POP_MS = 220;
const BOOM_MS = 520;
const ARC_MS = 180;
const MAX_ARC_POINTS = 8;

const WOOD = [0x8a5a32, 0x7d5230, 0x93633a, 0x84552f];
const WOOD_REINFORCED = 0x6d5844;
const IRON = 0x3d4146;
const ACCENT = [0x000000, 0xd0d6dc, 0xffc840];

/** Body colour of each turret type (also its pad ring). */
export const TURRET_COLORS: Readonly<Record<ZdTurretType, number>> = {
	sentry: 0x5c7a99,
	scatter: 0xc46a2a,
	mortar: 0x6b7a3a,
	tesla: 0xb87333,
	frost: 0x7fe0ff
};

interface Plank {
	mesh: THREE.Mesh;
	/** Pop-in start (ms), −Infinity when settled. */
	popAt: number;
}

interface Barricade {
	group: THREE.Group;
	planks: Plank[];
	straps: THREE.Group;
	frame: THREE.LineSegments;
	label: THREE.Sprite;
	canvas: HTMLCanvasElement | null;
	tex: THREE.CanvasTexture | null;
	shown: number;
	max: number;
	reinforce: number;
	/** Outward unit direction (Source XY) for torn planks. */
	out: { x: number; y: number };
	/** Source centre. */
	cx: number;
	cy: number;
	cz: number;
	/** Width, height and thickness of the opening. */
	size: [number, number, number];
	/** Outward direction along the group's local z (±1). */
	outZ: number;
}

interface Debris {
	mesh: THREE.Mesh;
	mat: THREE.MeshLambertMaterial;
	at: number;
	v: THREE.Vector3;
	spin: THREE.Vector3;
}

interface Turret {
	type: ZdTurretType;
	level: number;
	root: THREE.Group;
	yawNode: THREE.Group;
	pitchNode: THREE.Group;
	/** Muzzle points in the pitch node (several barrels fire in turn). */
	muzzles: THREE.Object3D[];
	next: number;
	flash: THREE.Mesh;
	flashUntil: number;
	/** Tesla orb, frost crystal: glow when active. */
	glow: THREE.Mesh | null;
	aura: THREE.Mesh | null;
	active: boolean;
	yaw: number;
	pitch: number;
}

interface PadMesh {
	root: THREE.Group;
	ring: THREE.Mesh;
	ringMat: THREE.MeshBasicMaterial;
	beam: THREE.Mesh;
	beamMat: THREE.MeshBasicMaterial;
	turret: Turret | null;
	/** Source floor centre. */
	x: number;
	y: number;
	z: number;
	defYaw: number;
}

interface Shell {
	mesh: THREE.Mesh;
	at: number;
	ms: number;
	from: THREE.Vector3;
	to: THREE.Vector3;
	h: number;
}

interface Boom {
	mesh: THREE.Mesh;
	mat: THREE.MeshBasicMaterial;
	ring: THREE.Mesh;
	ringMat: THREE.MeshBasicMaterial;
	at: number;
	r: number;
}

interface Arc {
	line: THREE.Line;
	mat: THREE.LineBasicMaterial;
	at: number;
	pts: THREE.Vector3[];
}

const toThree = (out: THREE.Vector3, x: number, y: number, z: number) => out.set(x, z, -y);
const V = new THREE.Vector3();

export class DefenseRenderer {
	readonly group = new THREE.Group();
	private box = new THREE.BoxGeometry(1, 1, 1);
	private cyl = new THREE.CylinderGeometry(1, 1, 1, 12);
	private sphere = new THREE.SphereGeometry(1, 12, 8);
	private ringGeo = new THREE.RingGeometry(0.82, 1, 40);
	private disc = new THREE.CircleGeometry(1, 48);
	private torus = new THREE.TorusGeometry(1, 0.22, 6, 20);
	private crystal = new THREE.OctahedronGeometry(1);
	private mats = new Map<string, THREE.MeshLambertMaterial>();
	private flashMat = new THREE.MeshBasicMaterial({ color: 0xffd890, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
	private shellMat = new THREE.MeshLambertMaterial({ color: 0x2c2f22, emissive: 0x401800 });
	private barricades: Barricade[] = [];
	private debris: Debris[] = [];
	private pads: PadMesh[] = [];
	private shells: Shell[] = [];
	private booms: Boom[] = [];
	private arcs: Arc[] = [];
	private phase: ZdPhase = 'waiting';
	private lastUpdate = 0;

	constructor() {
		this.group.name = 'defense';
	}

	private mat(hex: number, emissive = 0): THREE.MeshLambertMaterial {
		const key = `${hex}:${emissive}`;
		let m = this.mats.get(key);
		if (!m) {
			// A little self-light: the defense maps are dim and turrets must read at a glance.
			m = new THREE.MeshLambertMaterial({ color: hex, emissive: emissive || new THREE.Color(hex).multiplyScalar(0.22).getHex() });
			this.mats.set(key, m);
		}
		return m;
	}

	/** A box in a parent's Three space: centre (x, y, z), size (sx, sy, sz). */
	private block(parent: THREE.Object3D, hex: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, emissive = 0): THREE.Mesh {
		const m = new THREE.Mesh(this.box, this.mat(hex, emissive));
		m.position.set(x, y, z);
		m.scale.set(sx, sy, sz);
		parent.add(m);
		return m;
	}

	/** A cylinder along the parent's +x from x0 (barrel), or upright (axis 'y'). */
	private rod(parent: THREE.Object3D, hex: number, r: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' = 'x', emissive = 0): THREE.Mesh {
		const m = new THREE.Mesh(this.cyl, this.mat(hex, emissive));
		m.scale.set(r, len, r);
		if (axis === 'x') {
			m.rotation.z = -Math.PI / 2;
			m.position.set(x + len / 2, y, z);
		} else m.position.set(x, y + len / 2, z);
		parent.add(m);
		return m;
	}

	// ---------------------------------------------------------------------
	// Map

	/** Build the barricades and pads of a defense map (fully boarded, empty pads). */
	setMap(info: DefenseMapInfo): void {
		this.reset();
		for (const o of info.openings) {
			const max = o.planks ?? 6;
			const cx = (o.min.x + o.max.x) / 2;
			const cy = (o.min.y + o.max.y) / 2;
			const cz = (o.min.z + o.max.z) / 2;
			const alongX = o.max.x - o.min.x >= o.max.y - o.min.y;
			const width = alongX ? o.max.x - o.min.x : o.max.y - o.min.y;
			const thick = alongX ? o.max.y - o.min.y : o.max.x - o.min.x;
			const height = o.max.z - o.min.z;
			const node = info.nav.nodes[o.outside];
			let ox = node ? node.x - cx : 0;
			let oy = node ? node.y - cy : 0;
			if (alongX) ox = 0;
			else oy = 0;
			const ol = Math.hypot(ox, oy) || 1;
			const out = { x: ox / ol, y: oy / ol };
			const group = new THREE.Group();
			toThree(group.position, cx, cy, cz);
			// Local space: x along the opening, z (Three) across it; turn for openings along Source y.
			if (!alongX) group.rotation.y = Math.PI / 2;
			const planks: Plank[] = [];
			const ph = Math.min(16, (height / max) * 0.72);
			for (let i = 0; i < max; i++) {
				const z = -height / 2 + 10 + ((height - 20) * (i + 0.5)) / max;
				const m = this.block(group, WOOD[i % WOOD.length]!, ((i * 37) % 7) - 3, z, 0, width + 14, ph, Math.min(5, thick * 0.4));
				m.rotation.z = (((i * 53) % 11) - 5) * 0.9 * DEG;
				planks.push({ mesh: m, popAt: -Infinity });
			}
			const straps = new THREE.Group();
			group.add(straps);
			const frame = new THREE.LineSegments(new THREE.EdgesGeometry(this.box), new THREE.LineBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.8 }));
			frame.scale.set(width, height, thick + 2);
			frame.visible = false;
			group.add(frame);
			// One count label on each face, just above the opening (the wall above would hide one in its middle).
			const label = this.makeLabel();
			label.sprite.position.set(0, height / 2 + 14, thick / 2 + 10);
			const back = new THREE.Sprite(label.sprite.material);
			back.scale.copy(label.sprite.scale);
			back.position.set(0, height / 2 + 14, -thick / 2 - 10);
			back.renderOrder = 4;
			group.add(label.sprite, back);
			this.group.add(group);
			const outZ = (alongX ? -out.y : out.x) || 1;
			const b: Barricade = { group, planks, straps, frame, label: label.sprite, canvas: label.canvas, tex: label.tex, shown: max, max, reinforce: -1, out, cx, cy, cz, size: [width, height, thick], outZ };
			this.setReinforce(b, 0, width, height, thick);
			this.drawLabel(b, max);
			this.barricades.push(b);
		}
		for (const p of info.pads) {
			const root = new THREE.Group();
			toThree(root.position, p.pos.x, p.pos.y, p.pos.z);
			const base = new THREE.Mesh(this.cyl, this.mat(0x2a2d31));
			base.scale.set(30, 3, 30);
			base.position.y = 1.5;
			const ringMat = new THREE.MeshBasicMaterial({ color: 0x5cffd0, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });
			const ring = new THREE.Mesh(this.ringGeo, ringMat);
			ring.rotation.x = -Math.PI / 2;
			ring.scale.setScalar(34);
			ring.position.y = 3.4;
			const beamMat = new THREE.MeshBasicMaterial({ color: 0x5cffd0, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending });
			const beam = new THREE.Mesh(this.cyl, beamMat);
			beam.scale.set(22, 90, 22);
			beam.position.y = 48;
			root.add(base, ring, beam);
			this.group.add(root);
			this.pads.push({ root, ring, ringMat, beam, beamMat, turret: null, x: p.pos.x, y: p.pos.y, z: p.pos.z, defYaw: p.yaw });
		}
	}

	private makeLabel(): { sprite: THREE.Sprite; canvas: HTMLCanvasElement | null; tex: THREE.CanvasTexture | null } {
		const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
		let tex: THREE.CanvasTexture | null = null;
		if (canvas) {
			canvas.width = 128;
			canvas.height = 48;
			tex = new THREE.CanvasTexture(canvas);
			tex.colorSpace = THREE.SRGBColorSpace;
		}
		const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
		sprite.scale.set(56, 21, 1);
		sprite.renderOrder = 4;
		return { sprite, canvas, tex };
	}

	private drawLabel(b: Barricade, planks: number): void {
		const c = b.canvas?.getContext('2d');
		if (!c || !b.canvas || !b.tex) return;
		c.clearRect(0, 0, 128, 48);
		c.fillStyle = 'rgba(8, 12, 18, 0.7)';
		c.fillRect(4, 4, 120, 40);
		const text = planks === 0 ? 'BROKEN' : `${planks}/${b.max}`;
		let px = 30;
		c.font = `bold ${px}px system-ui, sans-serif`;
		const w = c.measureText(text).width;
		if (w > 110) {
			px = Math.floor((px * 110) / w);
			c.font = `bold ${px}px system-ui, sans-serif`;
		}
		c.textAlign = 'center';
		c.textBaseline = 'middle';
		c.fillStyle = planks === 0 ? '#ff5050' : planks * 2 < b.max ? '#ffd24a' : '#e8f0e0';
		c.fillText(text, 64, 26);
		b.tex.needsUpdate = true;
	}

	private setReinforce(b: Barricade, level: number, width: number, height: number, thick: number): void {
		if (level === b.reinforce) return;
		b.reinforce = level;
		b.straps.clear();
		const d = Math.min(5, thick * 0.4) + 2;
		if (level >= 1) {
			for (const fx of [-0.3, 0.3]) this.block(b.straps, IRON, fx * width, 0, 0, 7, height - 6, d);
		}
		if (level >= 2) {
			this.block(b.straps, IRON, 0, height / 2 - 4, 0, width + 16, 6, d);
			this.block(b.straps, IRON, 0, -height / 2 + 4, 0, width + 16, 6, d);
			this.block(b.straps, IRON, 0, 0, 0, 7, height - 6, d);
			for (const p of b.planks) p.mesh.material = this.mat(WOOD_REINFORCED);
		} else for (const [i, p] of b.planks.entries()) p.mesh.material = this.mat(WOOD[i % WOOD.length]!);
	}

	/** Plank counts and reinforce levels by map index: torn planks fly off, new ones pop in. */
	setOpenings(states: readonly ZdOpeningView[], now: number): void {
		for (const [i, st] of states.entries()) {
			const b = this.barricades[i];
			if (!b) continue;
			this.setReinforce(b, st.reinforce, ...b.size);
			const n = Math.max(0, Math.min(b.max, st.planks));
			if (n === b.shown) continue;
			if (n < b.shown) for (let k = b.shown - 1; k >= n; k--) this.tear(b, k, now);
			else
				for (let k = b.shown; k < n; k++) {
					b.planks[k]!.mesh.visible = true;
					b.planks[k]!.popAt = now;
				}
			b.shown = n;
			b.frame.visible = n === 0;
			this.drawLabel(b, n);
		}
	}

	private tear(b: Barricade, k: number, now: number): void {
		const p = b.planks[k]!;
		p.mesh.visible = false;
		let d = this.debris.find((x) => now - x.at > DEBRIS_MS);
		if (!d) {
			const mat = new THREE.MeshLambertMaterial({ color: WOOD[0], transparent: true });
			d = { mesh: new THREE.Mesh(this.box, mat), mat, at: now, v: new THREE.Vector3(), spin: new THREE.Vector3() };
			this.group.add(d.mesh);
			this.debris.push(d);
		}
		p.mesh.updateWorldMatrix(true, false);
		p.mesh.matrixWorld.decompose(d.mesh.position, d.mesh.quaternion, d.mesh.scale);
		d.mat.color.copy((p.mesh.material as THREE.MeshLambertMaterial).color);
		d.mat.opacity = 1;
		d.mesh.visible = true;
		d.at = now;
		const sp = 160 + Math.random() * 120;
		d.v.set(b.out.x * sp + (Math.random() - 0.5) * 60, 140 + Math.random() * 120, -b.out.y * sp + (Math.random() - 0.5) * 60);
		d.spin.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 12);
	}

	// ---------------------------------------------------------------------
	// Pads and turrets

	/** Pad contents (type and level by map index) and the phase (empty pads glow while building). */
	setPads(pads: readonly ZdPadView[], phase: ZdPhase): void {
		this.phase = phase;
		for (const [i, pv] of pads.entries()) {
			const p = this.pads[i];
			if (!p) continue;
			const t = p.turret;
			if (t && (t.type !== pv.type || t.level !== pv.level)) {
				p.root.remove(t.root);
				this.disposeTree(t.root);
				p.turret = null;
			}
			if (pv.type && !p.turret) {
				p.turret = this.buildTurret(pv.type, pv.level, p.defYaw);
				p.root.add(p.turret.root);
			}
			const c = pv.type ? TURRET_COLORS[pv.type] : 0x5cffd0;
			p.ringMat.color.setHex(c);
		}
	}

	private buildTurret(type: ZdTurretType, level: number, yaw: number): Turret {
		const root = new THREE.Group();
		const yawNode = new THREE.Group();
		const pitchNode = new THREE.Group();
		const color = TURRET_COLORS[type];
		const accent = ACCENT[level - 1]!;
		const s = 1 + 0.1 * (level - 1);
		root.scale.setScalar(s);
		this.rod(root, 0x34383d, 15, 12, 0, 3, 0, 'y');
		// Level pips round the base.
		for (let i = 0; i < level; i++) {
			const pip = new THREE.Mesh(this.sphere, this.mat(level === 3 ? 0xffc840 : 0xe8f0e0, level === 3 ? 0x664400 : 0x222222));
			const a = (i - (level - 1) / 2) * 0.5;
			pip.position.set(Math.cos(a) * 17, 11, Math.sin(a) * 17);
			pip.scale.setScalar(2.6);
			root.add(pip);
		}
		yawNode.position.y = 15;
		root.add(yawNode);
		pitchNode.position.y = ZD_TURRET_HEIGHT / s - 15;
		yawNode.add(pitchNode);
		const muzzles: THREE.Object3D[] = [];
		const muzzle = (x: number, y: number, z: number) => {
			const o = new THREE.Object3D();
			o.position.set(x, y, z);
			pitchNode.add(o);
			muzzles.push(o);
		};
		let glow: THREE.Mesh | null = null;
		let aura: THREE.Mesh | null = null;
		switch (type) {
			case 'sentry': {
				this.rod(yawNode, 0x44494f, 5, pitchNode.position.y, 0, 0, 0, 'y');
				this.block(pitchNode, color, 0, 0, 0, 24, 14, 16);
				if (level >= 2) this.block(pitchNode, accent, -4, 7.5, 0, 16, 2, 17);
				if (level >= 3) this.block(pitchNode, 0x2e3236, -2, 0, -11, 14, 10, 6);
				const offs = level === 1 ? [0] : level === 2 ? [-4, 4] : [-5, 0, 5];
				for (const z of offs) {
					this.rod(pitchNode, 0x22262a, 2.2, 26 + level * 4, 10, 0, z);
					muzzle(36 + level * 4, 0, z);
				}
				break;
			}
			case 'scatter': {
				this.rod(yawNode, 0x44494f, 6, pitchNode.position.y, 0, 0, 0, 'y');
				this.block(pitchNode, color, 0, 0, 0, 22, 18, 24);
				if (level >= 2) this.block(pitchNode, accent, 0, 9.5, 0, 22, 2, 25);
				const offs: Array<[number, number]> = level === 1 ? [[0, 0]] : level === 2 ? [[0, -6], [0, 6]] : [[-5, -6], [-5, 6], [5, -6], [5, 6]];
				for (const [y, z] of offs) {
					this.rod(pitchNode, 0x22262a, level === 3 ? 3.6 : 5, 20, 10, y, z);
					muzzle(30, y, z);
				}
				break;
			}
			case 'mortar': {
				this.block(yawNode, color, 0, 4, 0, 30, 8, 30);
				if (level >= 2) for (const z of [-13, 13]) this.block(yawNode, accent, 0, 12, z, 26, 10, 3);
				const r = 6 + level;
				this.rod(pitchNode, color, r, 34, -6, 0, 0);
				if (level >= 3) this.rod(pitchNode, accent, r + 1.2, 3, 26, 0, 0);
				muzzle(30, 0, 0);
				break;
			}
			case 'tesla': {
				this.rod(yawNode, 0x3a3d42, 4, 42, 0, -2, 0, 'y');
				const coils = 2 + level;
				for (let i = 0; i < coils; i++) {
					const t = new THREE.Mesh(this.torus, this.mat(color));
					t.rotation.x = Math.PI / 2;
					t.scale.setScalar(9 - i * 0.8);
					t.position.y = 6 + i * (30 / coils);
					yawNode.add(t);
				}
				glow = new THREE.Mesh(this.sphere, new THREE.MeshLambertMaterial({ color: 0xc7b0ff, emissive: 0x5a30c0 }));
				glow.scale.setScalar(6 + level * 1.5);
				glow.position.y = 44;
				yawNode.add(glow);
				const o = new THREE.Object3D();
				o.position.y = 44;
				yawNode.add(o);
				muzzles.push(o);
				break;
			}
			case 'frost': {
				this.rod(yawNode, 0x3a4a55, 3, 20, 0, -2, 0, 'y');
				glow = new THREE.Mesh(this.crystal, new THREE.MeshLambertMaterial({ color, emissive: 0x206080, transparent: true, opacity: 0.9 }));
				glow.scale.set(8 + level * 2, 14 + level * 3, 8 + level * 2);
				glow.position.y = 32;
				yawNode.add(glow);
				if (level >= 2)
					for (let i = 0; i < level; i++) {
						const shard = new THREE.Mesh(this.crystal, this.mat(color, 0x103040));
						shard.scale.set(3, 6, 3);
						shard.position.set(Math.cos(i * 2.1) * 14, 22, Math.sin(i * 2.1) * 14);
						yawNode.add(shard);
					}
				const range = ZD_TURRETS.frost.levels[level - 1]!.range;
				aura = new THREE.Mesh(this.disc, new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }));
				aura.rotation.x = -Math.PI / 2;
				aura.scale.setScalar(range / s);
				aura.position.y = 2;
				root.add(aura);
				break;
			}
		}
		const flash = new THREE.Mesh(this.crystal, this.flashMat);
		flash.scale.set(9, 5, 5);
		flash.visible = false;
		pitchNode.add(flash);
		const t: Turret = { type, level, root, yawNode, pitchNode, muzzles, next: 0, flash, flashUntil: 0, glow, aura, active: false, yaw, pitch: type === 'mortar' ? 50 : 0 };
		this.pose(t);
		return t;
	}

	private pose(t: Turret): void {
		if (t.type === 'tesla' || t.type === 'frost') return;
		t.yawNode.rotation.y = t.yaw * DEG;
		const pitch = t.type === 'mortar' ? Math.max(35, t.pitch || 50) : t.pitch;
		t.pitchNode.rotation.z = pitch * DEG;
	}

	/** Aim of the built turrets this frame (BIN_DEFENSE, interpolated). */
	aim(turrets: readonly ZdTurretNet[]): void {
		for (const tn of turrets) {
			const t = this.pads[tn.pad]?.turret;
			if (!t) continue;
			t.yaw = tn.yaw;
			t.pitch = tn.pitch;
			t.active = (tn.flags & ZDT_ACTIVE) !== 0;
			this.pose(t);
		}
	}

	/** Turrets that are not in the snapshot (none during the build phase) rest and idle. */
	idle(): void {
		for (const p of this.pads) if (p.turret) p.turret.active = false;
	}

	/** Pad `pad` fired: muzzle flash; returns the muzzle (Source) into `out` for a tracer, false without a turret. */
	fired(pad: number, now: number, out: { x: number; y: number; z: number }): boolean {
		const t = this.pads[pad]?.turret;
		if (!t || t.muzzles.length === 0) return false;
		const m = t.muzzles[t.next++ % t.muzzles.length]!;
		if (t.type !== 'tesla' && t.type !== 'frost') {
			t.flash.position.copy(m.position);
			t.flash.visible = true;
			t.flashUntil = now + FLASH_MS;
		}
		m.getWorldPosition(V);
		out.x = V.x;
		out.y = -V.z;
		out.z = V.y;
		return true;
	}

	// ---------------------------------------------------------------------
	// Effects

	/** Mortar shell from pad `pad` landing at (x, y, z) after `ms`. */
	shell(pad: number, x: number, y: number, z: number, ms: number, now: number): void {
		const from = { x: 0, y: 0, z: 0 };
		if (!this.fired(pad, now, from)) return;
		let s = this.shells.find((q) => now - q.at > q.ms);
		if (!s) {
			const mesh = new THREE.Mesh(this.sphere, this.shellMat);
			mesh.scale.setScalar(5);
			this.group.add(mesh);
			s = { mesh, at: now, ms, from: new THREE.Vector3(), to: new THREE.Vector3(), h: 0 };
			this.shells.push(s);
		}
		s.at = now;
		s.ms = Math.max(50, ms);
		toThree(s.from, from.x, from.y, from.z);
		toThree(s.to, x, y, z);
		s.h = 80 + 0.3 * Math.hypot(x - from.x, y - from.y);
		s.mesh.visible = true;
	}

	/** Explosion of radius `r` at (x, y, z). */
	boom(x: number, y: number, z: number, r: number, now: number): void {
		let b = this.booms.find((q) => now - q.at > BOOM_MS);
		if (!b) {
			const mat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
			const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
			const mesh = new THREE.Mesh(this.sphere, mat);
			const ring = new THREE.Mesh(this.ringGeo, ringMat);
			ring.rotation.x = -Math.PI / 2;
			this.group.add(mesh, ring);
			b = { mesh, mat, ring, ringMat, at: now, r };
			this.booms.push(b);
		}
		b.at = now;
		b.r = r;
		toThree(b.mesh.position, x, y, z + 8);
		toThree(b.ring.position, x, y, z + 2);
		b.mesh.visible = b.ring.visible = true;
	}

	/** Tesla arc from pad `pad` through the points (x, y, z flat). */
	arc(pad: number, pts: readonly number[], now: number): void {
		const from = { x: 0, y: 0, z: 0 };
		if (!this.fired(pad, now, from)) return;
		let a = this.arcs.find((q) => now - q.at > ARC_MS);
		if (!a) {
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_ARC_POINTS * 4 * 3), 3));
			const mat = new THREE.LineBasicMaterial({ color: 0xd8c8ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
			const line = new THREE.Line(g, mat);
			line.frustumCulled = false;
			this.group.add(line);
			a = { line, mat, at: now, pts: [] };
			this.arcs.push(a);
		}
		a.at = now;
		a.pts = [toThree(new THREE.Vector3(), from.x, from.y, from.z)];
		for (let i = 0; i + 2 < pts.length && a.pts.length < MAX_ARC_POINTS; i += 3) a.pts.push(toThree(new THREE.Vector3(), pts[i]!, pts[i + 1]!, pts[i + 2]!));
		a.line.visible = true;
		this.jitter(a);
	}

	/** Jagged line through the arc's points: three random kinks per hop. */
	private jitter(a: Arc): void {
		const pos = a.line.geometry.getAttribute('position') as THREE.BufferAttribute;
		let k = 0;
		for (let i = 0; i + 1 < a.pts.length; i++) {
			const p = a.pts[i]!;
			const q = a.pts[i + 1]!;
			for (let s = 0; s < 4; s++) {
				const f = s / 4;
				const j = s === 0 ? 0 : 9;
				pos.setXYZ(k++, p.x + (q.x - p.x) * f + (Math.random() - 0.5) * j, p.y + (q.y - p.y) * f + (Math.random() - 0.5) * j, p.z + (q.z - p.z) * f + (Math.random() - 0.5) * j);
			}
		}
		const last = a.pts[a.pts.length - 1]!;
		pos.setXYZ(k++, last.x, last.y, last.z);
		a.line.geometry.setDrawRange(0, k);
		pos.needsUpdate = true;
	}

	// ---------------------------------------------------------------------

	update(now: number): void {
		const dt = this.lastUpdate > 0 ? Math.max(0, Math.min(0.05, (now - this.lastUpdate) / 1000)) : 1 / 60;
		this.lastUpdate = now;
		for (const b of this.barricades) {
			for (const p of b.planks) {
				if (p.popAt === -Infinity) continue;
				const f = Math.min(1, (now - p.popAt) / POP_MS);
				// Swung in from inside the base (where the repairer stands).
				p.mesh.position.z = -(1 - f) * (1 - f) * 28 * b.outZ;
				if (f >= 1) p.popAt = -Infinity;
			}
			if (b.frame.visible) (b.frame.material as THREE.LineBasicMaterial).opacity = 0.45 + 0.4 * Math.sin(now / 140);
		}
		for (const d of this.debris) {
			const t = now - d.at;
			if (!d.mesh.visible) continue;
			if (t > DEBRIS_MS) {
				d.mesh.visible = false;
				continue;
			}
			d.v.y -= 800 * dt;
			d.mesh.position.addScaledVector(d.v, dt);
			d.mesh.rotation.x += d.spin.x * dt;
			d.mesh.rotation.y += d.spin.y * dt;
			d.mesh.rotation.z += d.spin.z * dt;
			d.mat.opacity = Math.min(1, (DEBRIS_MS - t) / 400);
		}
		const building = this.phase === 'build';
		for (const p of this.pads) {
			const empty = !p.turret;
			p.beam.visible = empty && building;
			const pulse = 0.5 + 0.5 * Math.sin(now / 260);
			p.ringMat.opacity = empty ? (building ? 0.45 + 0.4 * pulse : 0.18) : 0.55;
			p.beamMat.opacity = 0.06 + 0.08 * pulse;
			const t = p.turret;
			if (!t) continue;
			t.flash.visible = now < t.flashUntil;
			if (t.flash.visible) t.flash.rotation.x = Math.random() * Math.PI;
			if (t.glow) {
				const m = t.glow.material as THREE.MeshLambertMaterial;
				const on = t.active ? 0.7 + 0.3 * Math.sin(now / 50) : 0.35;
				m.emissiveIntensity = on * (t.type === 'tesla' ? 2 : 1.4);
				if (t.type === 'frost') t.glow.rotation.y = now / 900;
			}
			if (t.aura) (t.aura.material as THREE.MeshBasicMaterial).opacity = t.active ? 0.12 + 0.06 * Math.sin(now / 200) : building ? 0.07 : 0.035;
		}
		for (const s of this.shells) {
			if (!s.mesh.visible) continue;
			const f = (now - s.at) / s.ms;
			if (f >= 1) {
				s.mesh.visible = false;
				continue;
			}
			s.mesh.position.lerpVectors(s.from, s.to, f);
			s.mesh.position.y += s.h * 4 * f * (1 - f);
		}
		for (const b of this.booms) {
			if (!b.mesh.visible) continue;
			const f = (now - b.at) / BOOM_MS;
			if (f >= 1) {
				b.mesh.visible = b.ring.visible = false;
				continue;
			}
			const e = 1 - (1 - f) * (1 - f);
			b.mesh.scale.setScalar(Math.max(1, b.r * 0.55 * e));
			b.mat.opacity = 0.85 * (1 - f);
			b.mat.color.setHex(f < 0.25 ? 0xfff0b0 : 0xff8030);
			b.ring.scale.setScalar(Math.max(1, b.r * e));
			b.ringMat.opacity = 0.7 * (1 - f);
		}
		for (const a of this.arcs) {
			if (!a.line.visible) continue;
			const f = (now - a.at) / ARC_MS;
			if (f >= 1) {
				a.line.visible = false;
				continue;
			}
			a.mat.opacity = 1 - f * 0.7;
			this.jitter(a);
		}
	}

	private disposeTree(o: THREE.Object3D): void {
		o.traverse((c) => {
			const m = c as THREE.Mesh;
			// Shared geometry and cached materials stay; per-turret materials go.
			if (m.isMesh && m.material !== this.flashMat && ![...this.mats.values()].includes(m.material as THREE.MeshLambertMaterial)) (m.material as THREE.Material).dispose();
		});
	}

	/** Map unload: drop everything. */
	reset(): void {
		for (const b of this.barricades) {
			b.frame.geometry.dispose();
			(b.frame.material as THREE.Material).dispose();
			(b.label.material as THREE.SpriteMaterial).dispose();
			b.tex?.dispose();
		}
		for (const p of this.pads) {
			if (p.turret) this.disposeTree(p.turret.root);
			p.ringMat.dispose();
			p.beamMat.dispose();
		}
		for (const d of this.debris) d.mat.dispose();
		for (const b of this.booms) {
			b.mat.dispose();
			b.ringMat.dispose();
		}
		for (const a of this.arcs) {
			a.line.geometry.dispose();
			a.mat.dispose();
		}
		this.group.clear();
		this.barricades = [];
		this.debris = [];
		this.pads = [];
		this.shells = [];
		this.booms = [];
		this.arcs = [];
	}

	dispose(): void {
		this.reset();
		for (const m of this.mats.values()) m.dispose();
		this.mats.clear();
		this.flashMat.dispose();
		this.shellMat.dispose();
		for (const g of [this.box, this.cyl, this.sphere, this.ringGeo, this.disc, this.torus, this.crystal]) g.dispose();
		this.group.removeFromParent();
	}
}
