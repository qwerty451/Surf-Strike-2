/** Safe localStorage wrapper: every access is guarded (private mode, blocked storage, SSR). */
export interface KeyValueStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

function ls(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

export const browserStore: KeyValueStore = {
	get(key) {
		try {
			return ls()?.getItem(key) ?? null;
		} catch {
			return null;
		}
	},
	set(key, value) {
		try {
			ls()?.setItem(key, value);
		} catch {
			// quota or blocked: settings simply do not persist
		}
	},
	remove(key) {
		try {
			ls()?.removeItem(key);
		} catch {
			// ignore
		}
	}
};

/** In-memory store, used by tests and as a fallback. */
export function memoryStore(init: Record<string, string> = {}): KeyValueStore {
	const m = new Map(Object.entries(init));
	return {
		get: (k) => m.get(k) ?? null,
		set: (k, v) => void m.set(k, v),
		remove: (k) => void m.delete(k)
	};
}

export function readJson<T>(store: KeyValueStore, key: string): T | null {
	const raw = store.get(key);
	if (raw == null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

export function writeJson(store: KeyValueStore, key: string, value: unknown): void {
	store.set(key, JSON.stringify(value));
}

export const STORAGE_KEYS = {
	cvars: 'surf.cvars',
	binds: 'surf.binds',
	name: 'surf.name',
	playerId: 'surf.playerId',
	/** Session for a database identity within its origin or discovery source. */
	session: (scope: string) => `surf.session:${scope}`,
	/** '1' once the player chose "Play as guest" (the account panel stays closed on load). */
	guest: 'surf.guest',
	/** Map last played: shown first after a reload, until the server (if any) names its map. */
	lastMap: 'surf.lastMap',
	/** '1' once the fullscreen / Ctrl+W hint was shown. */
	fullscreenHint: 'surf.hint.fullscreen',
	pb: (mapId: string) => `surf.pb.${mapId}`
} as const;
