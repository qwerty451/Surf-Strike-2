/** Thin WebSocket wrapper: JSON text frames, binary snapshots and ghost frames. */
import {
	BIN_DEFENSE,
	BIN_GHOST,
	BIN_SNAPSHOT,
	BIN_ZOMBIES,
	decodeDefense,
	decodeGhostFrame,
	decodeSnapshot,
	decodeZombies,
	type DefenseFrame,
	type ZombieFrame,
	type ClientMessage,
	type GhostFrame,
	type ServerMessage,
	type SnapshotEntry
} from '@surf/shared';

export interface NetClientHandlers {
	open(): void;
	message(msg: ServerMessage): void;
	snapshot(entries: SnapshotEntry[], arrivalMs: number): void;
	/** BIN_GHOST frame: a map's record ghost, or "none" (docs/gameplay.md#ghosts). */
	ghost?(frame: GhostFrame): void;
	/** BIN_ZOMBIES frame (zombies maps, docs/modes.md#zombies). */
	zombies?(frame: ZombieFrame, arrivalMs: number): void;
	/** BIN_DEFENSE frame (Zombie Defense maps, docs/modes.md#zombie-defense). */
	defense?(frame: DefenseFrame, arrivalMs: number): void;
	/** `code` is the WebSocket close code (0 when the socket never existed or was closed locally). */
	close(wasOpen: boolean, code: number): void;
}

const OPEN_TIMEOUT_MS = 8000;

export class NetClient {
	private ws: WebSocket | null;
	private opened = false;
	private closed = false;
	private openTimer: ReturnType<typeof setTimeout> | null;

	constructor(
		readonly url: string,
		private h: NetClientHandlers
	) {
		let ws: WebSocket | null = null;
		try {
			ws = new WebSocket(url);
		} catch {
			ws = null;
		}
		this.ws = ws;
		this.openTimer = null;
		if (!ws) {
			queueMicrotask(() => this.finish());
			return;
		}
		ws.binaryType = 'arraybuffer';
		this.openTimer = setTimeout(() => this.close(), OPEN_TIMEOUT_MS);
		ws.onopen = () => {
			if (this.openTimer) clearTimeout(this.openTimer);
			this.openTimer = null;
			this.opened = true;
			this.h.open();
		};
		ws.onmessage = (ev) => {
			if (this.closed) return;
			const data = ev.data;
			if (typeof data === 'string') {
				let msg: ServerMessage;
				try {
					msg = JSON.parse(data) as ServerMessage;
				} catch {
					return;
				}
				if (msg && typeof msg === 'object' && typeof msg.type === 'string') this.h.message(msg);
			} else if (data instanceof ArrayBuffer && data.byteLength > 0) {
				const kind = new Uint8Array(data, 0, 1)[0];
				if (kind === BIN_GHOST) {
					const frame = decodeGhostFrame(data);
					if (frame) this.h.ghost?.(frame);
					return;
				}
				if (kind === BIN_ZOMBIES) {
					const frame = decodeZombies(data);
					if (frame) this.h.zombies?.(frame, performance.now());
					return;
				}
				if (kind === BIN_DEFENSE) {
					const frame = decodeDefense(data);
					if (frame) this.h.defense?.(frame, performance.now());
					return;
				}
				if (kind !== BIN_SNAPSHOT) return;
				const entries = decodeSnapshot(data);
				if (entries) this.h.snapshot(entries, performance.now());
			}
		};
		ws.onclose = (ev) => this.finish(ev.code);
		ws.onerror = () => {
			// onclose follows
		};
	}

	get isOpen(): boolean {
		return this.opened && !this.closed && this.ws?.readyState === WebSocket.OPEN;
	}

	send(msg: ClientMessage): void {
		if (this.isOpen) this.ws!.send(JSON.stringify(msg));
	}

	sendBinary(buf: ArrayBuffer): void {
		if (this.isOpen) this.ws!.send(buf);
	}

	close(): void {
		if (this.closed) return;
		try {
			this.ws?.close();
		} catch {
			// ignore
		}
		this.finish();
	}

	private finish(code = 0): void {
		if (this.closed) return;
		this.closed = true;
		if (this.openTimer) clearTimeout(this.openTimer);
		this.openTimer = null;
		if (this.ws) {
			this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
		}
		this.h.close(this.opened, code);
	}
}
