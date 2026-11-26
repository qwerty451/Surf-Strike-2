import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from '@surf/shared';
import { Db } from './db.ts';
import { Lobby } from './lobby.ts';
import { testMap } from './test-helpers.ts';
import { UNRELIABLE_BACKLOG_MIN, UNRELIABLE_BACKLOG_MULT, WsClientTransport, type ClientTransport } from './transport.ts';

function fakeSocket(bufferedAmount = 0) {
	const sent: Array<string | Uint8Array> = [];
	const ws = {
		OPEN: 1,
		readyState: 1,
		bufferedAmount,
		send(data: string | Uint8Array) {
			sent.push(data);
		},
		on() {},
		close() {},
		terminate() {}
	};
	return { ws: ws as unknown as WebSocket & { bufferedAmount: number; readyState: number }, sent };
}

describe('WsClientTransport', () => {
	it('drops droppable frames past a small snapshot backlog instead of buffering 1 MiB', () => {
		const { ws, sent } = fakeSocket(0);
		const t = new WsClientTransport(ws);
		const snap32p = new Uint8Array(1005); // 32-player v2 snapshot

		// Under budget (~3 snapshots = 3015 B): delivered.
		ws.bufferedAmount = 1005;
		assert.equal(t.sendUnreliable(snap32p), true);
		assert.equal(sent.length, 1);
		assert.equal(t.droppedUnreliable, 0);

		// Just above 3 snapshots (3016 B, far below old 1 MiB limit): dropped.
		ws.bufferedAmount = snap32p.byteLength * UNRELIABLE_BACKLOG_MULT + 1;
		assert.equal(t.sendUnreliable(snap32p), false);
		assert.equal(sent.length, 1);
		assert.equal(t.droppedUnreliable, 1);

		// Small 260 B snapshot uses UNRELIABLE_BACKLOG_MIN (2048 B) floor so normal bursts never drop.
		const snap8p = new Uint8Array(260);
		ws.bufferedAmount = UNRELIABLE_BACKLOG_MIN;
		assert.equal(t.sendUnreliable(snap8p), true);
		ws.bufferedAmount = UNRELIABLE_BACKLOG_MIN + 1;
		assert.equal(t.sendUnreliable(snap8p), false);
		assert.equal(t.droppedUnreliable, 2);

		// Reliable frames (JSON events, BIN_GHOST) are never dropped for backlog.
		ws.bufferedAmount = 100_000;
		t.sendReliable('{"type":"chat"}');
		t.sendReliable(new Uint8Array(500));
		assert.equal(sent.length, 4);
	});
});

class MemoryTransport implements ClientTransport {
	open = true;
	bufferedAmount = 0;
	droppedUnreliable = 0;
	readonly messages: ServerMessage[] = [];
	readonly binaries: Uint8Array[] = [];
	private onMsg: ((data: Buffer, isBinary: boolean) => void) | null = null;
	private onCls: (() => void) | null = null;

	sendReliable(data: string | Uint8Array): void {
		if (!this.open) return;
		if (typeof data === 'string') this.messages.push(JSON.parse(data) as ServerMessage);
		else this.binaries.push(data);
	}
	sendUnreliable(data: Uint8Array): boolean {
		if (!this.open) return false;
		this.binaries.push(data);
		return true;
	}
	onMessage(cb: (data: Buffer, isBinary: boolean) => void): void {
		this.onMsg = cb;
	}
	onClose(cb: () => void): void {
		this.onCls = cb;
	}
	onError(): void {}
	close(): void {
		if (!this.open) return;
		this.open = false;
		this.onCls?.();
	}
	terminate(): void {
		this.close();
	}
	receiveJson(msg: unknown): void {
		this.onMsg?.(Buffer.from(JSON.stringify(msg), 'utf8'), false);
	}
}

describe('Lobby transport seam and clock sync', () => {
	it('accepts a custom ClientTransport, advertises snapshotHz, and answers client ping with serverTime', () => {
		let clock = 12_345.5;
		const db = new Db(':memory:');
		const lobby = new Lobby({
			maps: [testMap()],
			db,
			timers: false,
			snapshotHz: 64,
			playClock: () => clock,
			log: () => {}
		});
		const t = new MemoryTransport();
		lobby.handleConnection(t);
		t.receiveJson({ type: 'hello', playerId: 'player-transport-1', name: 'Alice', version: PROTOCOL_VERSION });

		const welcome = t.messages.find((m) => m.type === 'welcome');
		assert.ok(welcome && welcome.type === 'welcome');
		assert.equal(welcome.snapshotHz, 64);
		assert.equal(welcome.serverTime, 12_345.5);

		clock = 13_000.25;
		t.receiveJson({ type: 'ping', t: 999.5 });
		const pong = t.messages.find((m) => m.type === 'pong');
		assert.deepEqual(pong, { type: 'pong', t: 999.5, serverTime: 13_000.25 });

		lobby.close();
		db.close();
	});
});
