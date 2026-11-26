import { randomUUID } from 'node:crypto';
import { connect as connectTcp, isIP } from 'node:net';
import { checkServerIdentity, connect as connectTls } from 'node:tls';
import { WebSocket, type ClientOptions } from 'ws';
import type { Relay } from './relay.ts';

export interface Welcome {
	type: 'welcome';
	version?: number;
	selfId: number;
	map: string;
	mode?: string;
	mapTimeLeft?: number;
	serverTime?: number;
	snapshotHz?: number;
}

export interface ClockPong {
	type: 'pong';
	t: number;
	serverTime: number;
}
type Message =
	| Welcome
	| { type: 'leave'; id: number }
	| { type: 'ping'; t: number }
	| ClockPong
	| { type: 'mapChange'; map: string }
	| { type: 'banned'; reason: string }
	| { type: 'full' };

export interface PeerHandlers {
	snapshot?(data: ArrayBuffer, arrival: number): void;
	message?(message: Message, arrivalMs: number): void;
	rtt?(ms: number): void;
	fail(error: Error): void;
}

export class Peer {
	readonly welcome: Promise<Welcome>;
	private readonly socket: WebSocket;
	private closing = false;
	private pingAt = 0;
	private pingId = 0;
	private pendingPing: Buffer | null = null;

	constructor(url: URL, relay: Relay | null, name: string, version: number, handlers: PeerHandlers) {
		const options: ClientOptions = {
			handshakeTimeout: 8_000,
			origin: url.origin.replace(/^ws/, 'http'),
			perMessageDeflate: true,
			maxPayload: 4 << 20
		};
		if (relay) {
			const netOptions = { host: '127.0.0.1', port: relay.port };
			const hostname = url.hostname.replace(/^\[|\]$/g, '');
			options.createConnection = () => url.protocol === 'wss:'
				? connectTls({
					...netOptions,
					servername: isIP(hostname) ? undefined : hostname,
					// Verify the deployed endpoint's identity, including IP literals.
					checkServerIdentity: (_host, cert) => checkServerIdentity(hostname, cert)
				})
				: connectTcp(netOptions);
		}
		const ws = this.socket = new WebSocket(url, options);
		ws.binaryType = 'arraybuffer';
		this.welcome = new Promise<Welcome>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`${name}: timed out waiting for welcome`));
			}, 10_000);
			ws.on('error', (error) => {
				clearTimeout(timeout);
				const failure = new Error(`${name}: ${error.message}`);
				reject(failure);
				if (!this.closing) handlers.fail(failure);
			});
			ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', playerId: randomUUID(), name, version })));
			ws.on('close', (code, reason) => {
				clearTimeout(timeout);
				const failure = new Error(`${name} closed (${code}${reason.length ? `: ${reason.toString()}` : ''})`);
				reject(failure);
				if (!this.closing) handlers.fail(failure);
			});
			ws.on('message', (data, binary) => {
				if (binary) {
					if (data instanceof ArrayBuffer) handlers.snapshot?.(data, performance.now());
					return;
				}
				let message: Message;
				try {
					message = JSON.parse(data.toString()) as Message;
				} catch {
					return;
				}
				if (message?.type === 'welcome') {
					clearTimeout(timeout);
					// v1 and v2 did not advertise a revision in welcome.
					if ((version >= 3 || message.version !== undefined) && message.version !== version) {
						const failure = new Error(`${name}: /health advertised v${version} but welcome reported ${message.version ?? 'no version'}`);
						reject(failure);
						handlers.fail(failure);
						return;
					}
					resolve(message);
				}
				if (message?.type === 'ping' && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: 'pong', t: message.t }));
				}
				handlers.message?.(message, performance.now());
			});
		});
		ws.on('pong', (payload) => {
			if (this.pendingPing?.equals(payload)) {
				this.pendingPing = null;
				handlers.rtt?.(performance.now() - this.pingAt);
			}
		});
	}

	sendState(state: ArrayBuffer): void {
		if (this.socket.readyState === WebSocket.OPEN) {
			if (this.socket.bufferedAmount > 1 << 20) throw new Error('Client WebSocket backlog exceeded 1 MiB');
			this.socket.send(state);
		}
	}

	clockPing(atMs: number): void {
		if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'ping', t: atMs }));
	}

	ping(): void {
		if (this.socket.readyState !== WebSocket.OPEN) return;
		const payload = Buffer.alloc(4);
		payload.writeUInt32LE(this.pingId++);
		this.pendingPing = payload;
		this.pingAt = performance.now();
		this.socket.ping(payload);
	}

	async close(): Promise<boolean> {
		this.closing = true;
		const ws = this.socket;
		if (ws.readyState === WebSocket.CLOSED) return false;
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => ws.terminate(), 2000);
			ws.once('close', (code) => {
				clearTimeout(timer);
				resolve(code === 1000);
			});
			if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'probe finished');
			else ws.terminate();
		});
	}
}
