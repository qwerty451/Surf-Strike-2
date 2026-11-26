/** Thin transport-agnostic client: JSON text frames, binary snapshots and ghost frames. */
import {
	BIN_DEFENSE,
	BIN_GHOST,
	BIN_SNAPSHOT,
	BIN_ZOMBIES,
	SERVER_ID_PROTOCOL,
	decodeDefense,
	decodeGhostFrame,
	decodeSnapshot,
	decodeZombies,
	type DefenseFrame,
	type ZombieFrame,
	type ClientMessage,
	type GhostFrame,
	type ServerMessage,
	type SnapshotFrame
} from '@surf/shared';
import { createWsTransport, type NetTransport, type NetTransportFactory } from './transport.js';

export interface NetClientHandlers {
	open(serverId: string | null): void;
	message(msg: ServerMessage): void;
	snapshot(frame: SnapshotFrame, arrivalMs: number): void;
	/** BIN_GHOST frame: a map's record ghost, or "none" (docs/gameplay.md#ghosts). */
	ghost?(frame: GhostFrame): void;
	/** BIN_ZOMBIES frame (zombies maps, docs/modes.md#zombies). */
	zombies?(frame: ZombieFrame, arrivalMs: number): void;
	/** Inbound/outbound wire bytes (for `net_graph`). */
	traffic?(dir: 'in' | 'out', bytes: number, atMs: number): void;
	/** BIN_DEFENSE frame (Zombie Defense maps, docs/modes.md#zombie-defense). */
	defense?(frame: DefenseFrame, arrivalMs: number): void;
	/** `code` is the close code (0 when the socket never existed or was closed locally). */
	close(wasOpen: boolean, code: number): void;
}

const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
function textBytes(s: string): number {
	return utf8Encoder ? utf8Encoder.encode(s).byteLength : s.length;
}

const OPEN_TIMEOUT_MS = 8000;
const SERVER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class NetClient {
	private transport: NetTransport | null;
	private opened = false;
	private waitingForIdentity = false;
	private closed = false;
	private openTimer: ReturnType<typeof setTimeout> | null;

	constructor(
		readonly url: string,
		private h: NetClientHandlers,
		transportFactory: NetTransportFactory = createWsTransport
	) {
		this.openTimer = null;
		this.transport = transportFactory(url, {
			open: (protocol) => {
				if (this.closed) return;
				this.opened = true;
				this.waitingForIdentity = protocol === SERVER_ID_PROTOCOL;
				if (!this.waitingForIdentity) this.identify(null);
			},
			text: (data, now) => {
				if (this.closed) return;
				this.h.traffic?.('in', textBytes(data), now);
				let msg: ServerMessage;
				try {
					msg = JSON.parse(data) as ServerMessage;
				} catch {
					return;
				}
				if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
				if (msg.type === 'serverIdentity') {
					if (this.waitingForIdentity && typeof msg.serverId === 'string' && SERVER_ID_RE.test(msg.serverId)) {
						this.identify(msg.serverId);
					}
					return;
				}
				this.h.message(msg);
			},
			binary: (data, now) => {
				if (this.closed) return;
				this.h.traffic?.('in', data.byteLength, now);
				const kind = new Uint8Array(data, 0, 1)[0];
				if (kind === BIN_GHOST) {
					const frame = decodeGhostFrame(data);
					if (frame) this.h.ghost?.(frame);
					return;
				}
				if (kind === BIN_ZOMBIES) {
					const frame = decodeZombies(data);
					if (frame) this.h.zombies?.(frame, now);
					return;
				}
				if (kind === BIN_DEFENSE) {
					const frame = decodeDefense(data);
					if (frame) this.h.defense?.(frame, now);
					return;
				}
				if (kind !== BIN_SNAPSHOT) return;
				const frame = decodeSnapshot(data);
				if (frame) this.h.snapshot(frame, now);
			},
			close: (code) => this.finish(code)
		});
		if (!this.transport) {
			queueMicrotask(() => this.finish());
			return;
		}
		this.openTimer = setTimeout(() => this.close(), OPEN_TIMEOUT_MS);
	}

	get isOpen(): boolean {
		return this.opened && !this.waitingForIdentity && !this.closed && (this.transport?.isOpen ?? false);
	}

	send(msg: ClientMessage): void {
		if (!this.isOpen) return;
		const raw = JSON.stringify(msg);
		this.transport!.sendText(raw);
		this.h.traffic?.('out', textBytes(raw), performance.now());
	}

	sendBinary(buf: ArrayBuffer, reliable = false): void {
		if (!this.isOpen) return;
		this.transport!.sendBinary(buf, reliable);
		this.h.traffic?.('out', buf.byteLength, performance.now());
	}

	close(code = 0): void {
		if (this.closed) return;
		this.transport?.close();
		this.finish(code);
	}

	private identify(serverId: string | null): void {
		if (this.openTimer === null) return;
		clearTimeout(this.openTimer);
		this.openTimer = null;
		this.waitingForIdentity = false;
		this.h.open(serverId);
	}

	private finish(code = 0): void {
		if (this.closed) return;
		this.closed = true;
		if (this.openTimer) clearTimeout(this.openTimer);
		this.openTimer = null;
		this.h.close(this.opened, code);
	}
}
