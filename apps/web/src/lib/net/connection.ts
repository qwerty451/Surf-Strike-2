/**
 * Connection manager: discovery, connect, retry every 10 s while offline,
 * manual `connect <url>` / `disconnect` (docs/architecture.md#client-connect-flow).
 */
import type { DefenseFrame, GhostFrame, ServerMessage, SnapshotEntry, ZombieFrame } from '@surf/shared';
import { NetClient } from './client.js';
import { DEV_FALLBACK_URL, discover, RETRY_MS, toWsUrl } from './discovery.js';

export interface ConnectionHandlers {
	connecting(url: string): void;
	open(client: NetClient): void;
	message(msg: ServerMessage): void;
	snapshot(entries: SnapshotEntry[], arrivalMs: number): void;
	/** BIN_GHOST frame (docs/gameplay.md#ghosts). */
	ghost?(frame: GhostFrame): void;
	/** BIN_ZOMBIES frame (docs/modes.md#zombies). */
	zombies?(frame: ZombieFrame, arrivalMs: number): void;
	/** BIN_DEFENSE frame (docs/modes.md#zombie-defense). */
	defense?(frame: DefenseFrame, arrivalMs: number): void;
	/** `code`: WebSocket close code (4002 = same player/account connected elsewhere). */
	closed(wasOpen: boolean, url: string, code: number): void;
	/** Discovery found no server (still solo). */
	idle(): void;
}

export interface ConnectionOptions {
	override: string | null;
	dev: boolean;
	fetch: typeof fetch;
}

export class Connection {
	client: NetClient | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private abort: AbortController | null = null;
	private manualUrl: string | null = null;
	private stopped = false; // `disconnect` until next `connect`
	private disposed = false;
	private busy = false;
	private holdUntil = 0;

	constructor(
		private h: ConnectionHandlers,
		private opts: ConnectionOptions
	) {}

	start(): void {
		void this.attempt();
	}

	/** Manual connect; returns false for an invalid URL. */
	connect(raw: string): boolean {
		const url = toWsUrl(raw);
		if (!url) return false;
		this.manualUrl = url;
		this.stopped = false;
		this.holdUntil = 0;
		this.drop();
		void this.attempt();
		return true;
	}

	/** Manual disconnect: stay solo until `connect` (or reload). */
	disconnect(): void {
		this.stopped = true;
		this.manualUrl = null;
		this.clearTimer();
		this.drop();
	}

	/** Do not reconnect for a while (e.g. server full). */
	holdOff(ms: number): void {
		this.holdUntil = Date.now() + ms;
	}

	private drop(): void {
		this.abort?.abort();
		this.abort = null;
		const c = this.client;
		this.client = null;
		c?.close();
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	private schedule(ms = RETRY_MS): void {
		this.clearTimer();
		if (this.disposed || this.stopped) return;
		const wait = Math.max(ms, this.holdUntil - Date.now());
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.attempt();
		}, wait);
	}

	private async attempt(): Promise<void> {
		if (this.disposed || this.stopped || this.client || this.busy) return;
		if (Date.now() < this.holdUntil) return this.schedule();
		this.busy = true;
		let url = this.manualUrl ?? this.opts.override;
		if (!url) {
			this.abort = new AbortController();
			url = await discover(this.opts.fetch, this.abort.signal);
			this.abort = null;
			if (!url && this.opts.dev) url = DEV_FALLBACK_URL;
			// A manual `connect` may have arrived during discovery.
			url = this.manualUrl ?? url;
		}
		this.busy = false;
		if (this.disposed || this.stopped || this.client) return;
		if (!url) {
			this.h.idle();
			return this.schedule();
		}
		this.h.connecting(url);
		const target = url;
		const client: NetClient = new NetClient(target, {
			open: () => this.h.open(client),
			message: (m) => this.h.message(m),
			snapshot: (e, t) => this.h.snapshot(e, t),
			ghost: (f) => this.h.ghost?.(f),
			zombies: (f, t) => this.h.zombies?.(f, t),
			defense: (f, t) => this.h.defense?.(f, t),
			close: (wasOpen, code) => {
				if (this.client === client) this.client = null;
				this.h.closed(wasOpen, target, code);
				this.schedule();
			}
		});
		this.client = client;
	}

	dispose(): void {
		this.disposed = true;
		this.clearTimer();
		this.drop();
	}
}
