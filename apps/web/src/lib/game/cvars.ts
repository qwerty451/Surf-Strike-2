/**
 * Client cvars (docs/ui.md#developer-console). Physics `sv_*` cvars are not
 * stored here: they belong to the map/server profile (see game.ts).
 */
import { MAX_NAME, sanitizeText } from '@surf/shared';
import { readJson, STORAGE_KEYS, writeJson, type KeyValueStore } from './storage.js';

export type CvarValue = number | string;

export interface CvarDef {
	name: string;
	default: CvarValue;
	help: string;
	min?: number;
	max?: number;
	/** 0/1 toggle. */
	bool?: boolean;
	/** Round to an integer. */
	int?: boolean;
	/** Not saved to storage (e.g. `name`, which has its own key). */
	noSave?: boolean;
}

export const CLIENT_CVARS: readonly CvarDef[] = [
	{ name: 'sensitivity', default: 2, min: 0.0001, max: 100, help: 'Mouse sensitivity (Source-compatible)' },
	{ name: 'm_yaw', default: 0.022, min: -1, max: 1, help: 'Degrees per mouse count, horizontal' },
	{ name: 'm_pitch', default: 0.022, min: -1, max: 1, help: 'Degrees per mouse count, vertical' },
	{ name: 'zoom_sensitivity_ratio', default: 1, min: 0.1, max: 4, help: 'Scoped mouse sensitivity factor (1 = same hand movement per screen distance as unscoped)' },
	{ name: 'cl_aimtoggle', default: 0, bool: true, help: 'Infected: Mouse2 toggles aiming down sights instead of holding it' },
	{ name: 'fov', default: 90, min: 60, max: 130, help: 'Horizontal FOV at 4:3 (CS scaling for widescreen)' },
	{ name: 'volume', default: 0.5, min: 0, max: 1, help: 'Master volume 0-1' },
	{ name: 'cl_fullscreen', default: 1, bool: true, help: 'Play in fullscreen, where Ctrl+W cannot close the tab (Chromium browsers)' },
	{ name: 'cl_showfps', default: 0, bool: true, help: 'Show FPS counter' },
	{ name: 'cl_showpos', default: 0, bool: true, help: 'Show position, angles and velocity' },
	{ name: 'cl_showkeys', default: 0, bool: true, help: 'Show pressed keys' },
	{ name: 'net_graph', default: 0, min: 0, max: 2, int: true, help: 'Show network telemetry overlay (0 off, 1 bar, 2 bar + graph)' },
	{ name: 'cl_hideplayers', default: 0, bool: true, help: 'Hide other players' },
	{ name: 'cl_ghost', default: 1, bool: true, help: 'Show the record ghost on surf and bhop maps' },
	{ name: 'cl_scorepanel', default: 1, bool: true, help: 'Show the score panel on the right (map records or the current standing)' },
	{ name: 'cl_boxnews', default: 1, bool: true, help: 'Show what other players get from loot boxes and win in the casino' },
	{ name: 'cl_crosshairsize', default: 5, min: 0, max: 100, help: 'Crosshair line length' },
	{ name: 'cl_crosshairgap', default: 1, min: -10, max: 100, help: 'Crosshair centre gap' },
	{ name: 'cl_crosshairthickness', default: 1, min: 0.5, max: 20, help: 'Crosshair line thickness' },
	{ name: 'cl_crosshaircolor_r', default: 0, min: 0, max: 255, int: true, help: 'Crosshair red 0-255' },
	{ name: 'cl_crosshaircolor_g', default: 255, min: 0, max: 255, int: true, help: 'Crosshair green 0-255' },
	{ name: 'cl_crosshaircolor_b', default: 0, min: 0, max: 255, int: true, help: 'Crosshair blue 0-255' },
	{ name: 'cl_crosshairdot', default: 0, bool: true, help: 'Crosshair centre dot' },
	{ name: 'name', default: 'Player', noSave: true, help: 'Your player name' }
];

export type CvarParse = { ok: true; value: CvarValue } | { ok: false; error: string };

/** Parse and validate a raw value for a cvar definition. */
export function parseCvarValue(def: CvarDef, raw: CvarValue): CvarParse {
	if (typeof def.default === 'string') {
		const s = sanitizeText(String(raw), def.name === 'name' ? MAX_NAME : 256);
		if (!s) return { ok: false, error: `${def.name}: value cannot be empty` };
		return { ok: true, value: s };
	}
	let n = typeof raw === 'number' ? raw : Number(String(raw).trim());
	if (typeof raw === 'string') {
		const t = raw.trim().toLowerCase();
		if (def.bool && (t === 'true' || t === 'on')) n = 1;
		if (def.bool && (t === 'false' || t === 'off')) n = 0;
	}
	if (!Number.isFinite(n)) return { ok: false, error: `${def.name}: "${raw}" is not a number` };
	if (def.bool) n = n !== 0 ? 1 : 0;
	if (def.int) n = Math.round(n);
	if (def.min !== undefined && n < def.min) n = def.min;
	if (def.max !== undefined && n > def.max) n = def.max;
	return { ok: true, value: n };
}

export function formatCvarValue(v: CvarValue): string {
	if (typeof v === 'string') return v;
	return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
}

export class ClientCvars {
	readonly defs = new Map<string, CvarDef>();
	private values = new Map<string, CvarValue>();
	private listeners: Array<(name: string, value: CvarValue) => void> = [];

	constructor(
		private store: KeyValueStore,
		defs: readonly CvarDef[] = CLIENT_CVARS
	) {
		for (const d of defs) {
			this.defs.set(d.name, d);
			this.values.set(d.name, d.default);
		}
		const saved = readJson<Record<string, CvarValue>>(store, STORAGE_KEYS.cvars);
		if (saved && typeof saved === 'object') {
			for (const [k, v] of Object.entries(saved)) {
				const d = this.defs.get(k);
				if (!d || d.noSave) continue;
				const p = parseCvarValue(d, v);
				if (p.ok) this.values.set(k, p.value);
			}
		}
	}

	has(name: string): boolean {
		return this.defs.has(name);
	}

	get(name: string): CvarValue | undefined {
		return this.values.get(name);
	}

	num(name: string): number {
		const v = this.values.get(name);
		return typeof v === 'number' ? v : Number(v) || 0;
	}

	str(name: string): string {
		return String(this.values.get(name) ?? '');
	}

	/** Set a cvar; returns an error string on failure. Persists on change. */
	set(name: string, raw: CvarValue): string | null {
		const d = this.defs.get(name);
		if (!d) return `Unknown cvar: ${name}`;
		const p = parseCvarValue(d, raw);
		if (!p.ok) return p.error;
		if (this.values.get(name) === p.value) return null;
		this.values.set(name, p.value);
		if (!d.noSave) this.save();
		for (const l of this.listeners) l(name, p.value);
		return null;
	}

	onChange(fn: (name: string, value: CvarValue) => void): () => void {
		this.listeners.push(fn);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== fn);
		};
	}

	snapshot(): Record<string, CvarValue> {
		return Object.fromEntries(this.values);
	}

	private save(): void {
		const out: Record<string, CvarValue> = {};
		for (const [k, v] of this.values) {
			const d = this.defs.get(k)!;
			if (!d.noSave && v !== d.default) out[k] = v;
		}
		writeJson(this.store, STORAGE_KEYS.cvars, out);
	}
}
