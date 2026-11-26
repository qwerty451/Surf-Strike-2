/**
 * Server-side per-client transport abstraction (docs/architecture.md#netcode).
 *
 * Isolates `Lobby` from raw `ws.WebSocket` details so a future datagram
 * transport (e.g. WebTransport) can plug into the same reliable/unreliable
 * seam, and enforces a small send-backlog drop budget on droppable frames
 * (snapshots, BIN_ZOMBIES) so a slow link never builds seconds of stale queue.
 */
import type { WebSocket } from 'ws';

/** Minimum backlog allowance (bytes) before dropping droppable frames (exceeds 1 TCP MSS). */
export const UNRELIABLE_BACKLOG_MIN = 2048;
/** Snapshot-multiple backlog budget: drop once > ~3 queued snapshots are waiting. */
export const UNRELIABLE_BACKLOG_MULT = 3;

export interface ClientTransport {
	readonly open: boolean;
	readonly bufferedAmount: number;
	/** Count of droppable unreliable frames dropped due to send backlog. */
	readonly droppedUnreliable: number;
	/** Send a reliable message (JSON text or reliable binary such as BIN_GHOST). Never dropped for backlog. */
	sendReliable(data: string | Uint8Array): void;
	/** Send a droppable binary frame (snapshots, BIN_ZOMBIES). Returns false if dropped or closed. */
	sendUnreliable(data: Uint8Array): boolean;
	onMessage(cb: (data: Buffer, isBinary: boolean) => void): void;
	ping?(challenge: string): void;
	onPong?(cb: (challenge: string) => void): void;
	onClose(cb: () => void): void;
	onError(cb: () => void): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
}

export interface WsTransportOptions {
	minBacklogBytes?: number;
	backlogMult?: number;
}

export class WsClientTransport implements ClientTransport {
	private dropped = 0;
	private readonly minBacklog: number;
	private readonly backlogMult: number;

	constructor(
		private readonly ws: WebSocket,
		opts: WsTransportOptions = {}
	) {
		this.minBacklog = opts.minBacklogBytes ?? UNRELIABLE_BACKLOG_MIN;
		this.backlogMult = opts.backlogMult ?? UNRELIABLE_BACKLOG_MULT;
	}

	get open(): boolean {
		return this.ws.readyState === this.ws.OPEN;
	}

	get bufferedAmount(): number {
		return this.ws.bufferedAmount;
	}

	get droppedUnreliable(): number {
		return this.dropped;
	}

	sendReliable(data: string | Uint8Array): void {
		if (this.ws.readyState !== this.ws.OPEN) return;
		this.ws.send(data);
	}

	sendUnreliable(data: Uint8Array): boolean {
		if (this.ws.readyState !== this.ws.OPEN) return false;
		const limit = Math.max(this.minBacklog, data.byteLength * this.backlogMult);
		if (this.ws.bufferedAmount > limit) {
			this.dropped++;
			return false;
		}
		this.ws.send(data);
		return true;
	}

	onMessage(cb: (data: Buffer, isBinary: boolean) => void): void {
		this.ws.on('message', (data, isBinary) => cb(data as Buffer, isBinary));
	}

	ping(challenge: string): void {
		if (this.open) this.ws.ping(challenge);
	}

	onPong(cb: (challenge: string) => void): void {
		this.ws.on('pong', (data) => cb(data.toString()));
	}

	onClose(cb: () => void): void {
		this.ws.on('close', cb);
	}

	onError(cb: () => void): void {
		this.ws.on('error', cb);
	}

	close(code?: number, reason?: string): void {
		this.ws.close(code, reason);
	}

	terminate(): void {
		this.ws.terminate();
	}
}

export function isClientTransport(v: WebSocket | ClientTransport): v is ClientTransport {
	return typeof (v as ClientTransport).sendUnreliable === 'function';
}
