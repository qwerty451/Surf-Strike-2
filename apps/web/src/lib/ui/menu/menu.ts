/**
 * Pure helpers for the Esc menu (docs/ui.md#esc-menu): map grouping by
 * gamemode, filtering, settings sections and their cvar defaults. No DOM.
 */
import { ADMIN_COINS_MAX, GAME_MODES, GAME_MODE_IDS, MAP_SIZE_LABELS, type AdminMapInfo } from '@surf/shared';
import type { MapListEntry } from '#lib/game/contract.js';
import { CLIENT_CVARS, type CvarDef } from '#lib/game/cvars.js';

/** Menu pages; 'main' is the top level. */
export type MenuView = 'main' | 'maps' | 'settings' | 'shop' | 'inventory' | 'coins' | 'casino' | 'account' | 'admin';

export interface MapGroup {
	/** Gamemode id (or the raw map kind for a kind not in the registry). */
	id: string;
	label: string;
	maps: MapListEntry[];
}

/** Known difficulties, easiest first; anything else sorts after them. */
export const DIFFICULTY_ORDER: readonly string[] = ['easy', 'medium', 'hard'];

export function difficultyRank(difficulty: string): number {
	const i = DIFFICULTY_ORDER.indexOf(difficulty.toLowerCase());
	return i < 0 ? DIFFICULTY_ORDER.length : i;
}

/** Sort rank of a size tag: medium before large; maps without one first. */
export function sizeRank(size: MapListEntry['size']): number {
	return size === 'medium' ? 1 : size === 'large' ? 2 : 0;
}

/** The badge of a map row: its size when it comes in sizes, else its difficulty. */
export function mapTag(m: Pick<MapListEntry, 'difficulty' | 'size'>): { label: string; cls: string } {
	return m.size ? { label: MAP_SIZE_LABELS[m.size], cls: `size-${m.size}` } : { label: m.difficulty, cls: `diff-${m.difficulty.toLowerCase()}` };
}

/** Maps by difficulty (easy first), then title, then size, then id. Does not mutate. */
export function sortMaps(maps: readonly MapListEntry[]): MapListEntry[] {
	return [...maps].sort(
		(a, b) =>
			difficultyRank(a.difficulty) - difficultyRank(b.difficulty) ||
			a.title.localeCompare(b.title) ||
			sizeRank(a.size) - sizeRank(b.size) ||
			a.id.localeCompare(b.id)
	);
}

/** Display label of a map kind: the gamemode label, or the kind capitalised. */
export function modeLabel(kind: string): string {
	const def = (GAME_MODES as Record<string, { label: string } | undefined>)[kind];
	if (def) return def.label;
	return kind ? kind[0].toUpperCase() + kind.slice(1) : 'Other';
}

/**
 * Maps grouped by gamemode in registry order (GAME_MODES), each group sorted
 * with sortMaps. Empty modes are left out; kinds not in the registry follow
 * in first-seen order, so new modes show up without UI changes.
 */
export function groupMapsByMode(
	maps: readonly MapListEntry[],
	order: readonly string[] = GAME_MODE_IDS
): MapGroup[] {
	const byKind = new Map<string, MapListEntry[]>();
	for (const m of maps) {
		const list = byKind.get(m.kind);
		if (list) list.push(m);
		else byKind.set(m.kind, [m]);
	}
	const kinds = [...order.filter((k) => byKind.has(k)), ...[...byKind.keys()].filter((k) => !order.includes(k))];
	return kinds.map((k) => ({ id: k, label: modeLabel(k), maps: sortMaps(byKind.get(k) ?? []) }));
}

/** Case-insensitive match on title, id or size; every whitespace-separated word must match. */
export function filterMaps(maps: readonly MapListEntry[], query: string): MapListEntry[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...maps];
	return maps.filter((m) => {
		const hay = `${m.title} ${m.id} ${m.size ?? ''}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

/** A server browser row can be picked: enabled maps, or any map for admins. */
export function mapSelectable(m: Pick<MapListEntry, 'disabled'>, admin: boolean): boolean {
	return admin || !m.disabled;
}

/** Players in a map's lobby; 0 when nobody plays it or offline. */
export function lobbyPlayers(counts: Readonly<Record<string, number>> | null, id: string): number {
	const n = counts?.[id];
	return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Everyone online, summed over the lobbies. */
export function totalPlayers(counts: Readonly<Record<string, number>> | null): number {
	let n = 0;
	for (const id of Object.keys(counts ?? {})) n += lobbyPlayers(counts, id);
	return n;
}

/**
 * The server browser's "Playing now" list (docs/ui.md#server-browser): the
 * maps with players, busiest first, then by title. Unknown ids are left out.
 */
export function busyMaps(maps: readonly MapListEntry[], counts: Readonly<Record<string, number>> | null): MapListEntry[] {
	return maps
		.filter((m) => lobbyPlayers(counts, m.id) > 0)
		.sort((a, b) => lobbyPlayers(counts, b.id) - lobbyPlayers(counts, a.id) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** "Empty", "1 player", "3 players". */
export function playersLabel(n: number): string {
	return n <= 0 ? 'Empty' : n === 1 ? '1 player' : `${n} players`;
}

export type AdminTabId = 'maps' | 'players' | 'bans' | 'abuse';

export const ADMIN_TABS: readonly { id: AdminTabId; label: string }[] = [
	{ id: 'maps', label: 'Maps' },
	{ id: 'players', label: 'Players' },
	{ id: 'bans', label: 'Bans' },
	{ id: 'abuse', label: 'Abuse log' }
];

export function isAdminTab(v: unknown): v is AdminTabId {
	return ADMIN_TABS.some((t) => t.id === v);
}

/** Whole coins typed into the Admin menu; null when not a number the server accepts. */
export function parseAdminCoins(v: string | number | null | undefined): number | null {
	const s = String(v ?? '').trim();
	const n = /^\d{1,6}$/.test(s) ? Number(s) : 0;
	return n >= 1 && n <= ADMIN_COINS_MAX ? n : null;
}

export interface AdminMapGroup {
	id: string;
	label: string;
	maps: AdminMapInfo[];
}

/** Admin map list grouped by gamemode (registry order, unknown kinds last), titles A-Z within a group. */
export function groupAdminMaps(maps: readonly AdminMapInfo[], order: readonly string[] = GAME_MODE_IDS): AdminMapGroup[] {
	const byKind = new Map<string, AdminMapInfo[]>();
	for (const m of maps) {
		const list = byKind.get(m.kind);
		if (list) list.push(m);
		else byKind.set(m.kind, [m]);
	}
	const kinds = [...order.filter((k) => byKind.has(k)), ...[...byKind.keys()].filter((k) => !order.includes(k))];
	return kinds.map((k) => ({
		id: k,
		label: modeLabel(k),
		maps: [...(byKind.get(k) ?? [])].sort((a, b) => a.title.localeCompare(b.title) || sizeRank(a.size) - sizeRank(b.size) || a.id.localeCompare(b.id))
	}));
}

/** The map may be switched off: it is enabled and not the last enabled map (the server keeps at least one). */
export function canDisableMap(maps: readonly AdminMapInfo[], id: string): boolean {
	const m = maps.find((x) => x.id === id);
	return !!m?.enabled && maps.filter((x) => x.enabled).length > 1;
}

/** Index after moving `delta` steps in a list of `n`, wrapping around. */
export function wrapIndex(i: number, delta: number, n: number): number {
	if (n <= 0) return 0;
	return (((i + delta) % n) + n) % n;
}

export type SettingsSectionId = 'mouse' | 'video' | 'hud' | 'audio';

export interface SettingsSection {
	id: SettingsSectionId;
	label: string;
	/** Cvars edited in this section (reset to defaults together). */
	cvars: readonly string[];
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
	{ id: 'mouse', label: 'Mouse', cvars: ['sensitivity', 'zoom_sensitivity_ratio', 'm_yaw', 'm_pitch', 'cl_aimtoggle'] },
	{ id: 'video', label: 'Video', cvars: ['fov', 'cl_fullscreen', 'cl_showfps', 'cl_showpos'] },
	{
		id: 'hud',
		label: 'HUD',
		cvars: [
			'cl_crosshaircolor_r',
			'cl_crosshaircolor_g',
			'cl_crosshaircolor_b',
			'cl_crosshairsize',
			'cl_crosshairgap',
			'cl_crosshairthickness',
			'cl_crosshairdot',
			'cl_showkeys',
			'cl_scorepanel',
			'cl_boxnews',
			'cl_ghost',
			'cl_hideplayers'
		]
	},
	{ id: 'audio', label: 'Audio', cvars: ['volume'] }
];

export function isSettingsSection(v: unknown): v is SettingsSectionId {
	return SETTINGS_SECTIONS.some((s) => s.id === v);
}

/** Client cvar definition by name (defaults and ranges, same as the console). */
export function cvarDef(name: string, defs: readonly CvarDef[] = CLIENT_CVARS): CvarDef | undefined {
	return defs.find((d) => d.name === name);
}

/** Numeric default of a client cvar (fallback when unknown or non-numeric). */
export function cvarDefault(name: string, fallback = 0): number {
	const d = cvarDef(name)?.default;
	return typeof d === 'number' ? d : fallback;
}

/** Clamp a value to the cvar's console range (min/max), or return it unchanged. */
export function clampCvar(name: string, value: number): number {
	const def = cvarDef(name);
	let v = value;
	if (def?.min !== undefined) v = Math.max(def.min, v);
	if (def?.max !== undefined) v = Math.min(def.max, v);
	return def?.int ? Math.round(v) : v;
}

/** [name, default] pairs for a section's cvars (unknown names skipped). */
export function sectionDefaults(
	id: SettingsSectionId,
	defs: readonly CvarDef[] = CLIENT_CVARS
): [string, number | string][] {
	const section = SETTINGS_SECTIONS.find((s) => s.id === id);
	if (!section) return [];
	const out: [string, number | string][] = [];
	for (const name of section.cvars) {
		const def = cvarDef(name, defs);
		if (def) out.push([name, def.default]);
	}
	return out;
}

/** Every cvar of the section already holds its default (missing counts as default). */
export function sectionIsDefault(cvars: Record<string, number | string>, id: SettingsSectionId): boolean {
	return sectionDefaults(id).every(([name, d]) => {
		const v = cvars[name];
		return v === undefined || v === d || Number(v) === d;
	});
}
