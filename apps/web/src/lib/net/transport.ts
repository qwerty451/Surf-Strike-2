/**
 * Client-side transport seam (docs/architecture.md#netcode).
 *
 * Isolates `NetClient` from raw `WebSocket` so an alternative datagram-capable
 * transport (e.g. WebTransport) can implement the same interface without
 * changing protocol framing or `Game`.
 */

import { SERVER_ID_PROTOCOL } from '@surf/shared';

export interface NetTransportHandlers {
	open(protocol?: string): void;
	text(data: string, arrivalMs: number): void;
	binary(data: ArrayBuffer, arrivalMs: number): void;
	close(code: number): void;
}

export interface NetTransport {
	readonly isOpen: boolean;
	sendText(data: string): void;
	/** Send a binary frame (`reliable` hints whether a datagram transport should use a stream). */
	sendBinary(data: ArrayBuffer, reliable?: boolean): void;
	close(): void;
}

export type NetTransportFactory = (url: string, handlers: NetTransportHandlers) => NetTransport | null;

export class WsNetTransport implements NetTransport {
	private ws: WebSocket;
	private closed = false;

	constructor(url: string, handlers: NetTransportHandlers) {
		const ws = new WebSocket(url, ['surf', SERVER_ID_PROTOCOL]);
		ws.binaryType = 'arraybuffer';
		this.ws = ws;
		ws.onopen = () => {
			if (!this.closed) handlers.open(ws.protocol);
		};
		ws.onmessage = (ev) => {
			if (this.closed) return;
			const now = performance.now();
			const data = ev.data;
			if (typeof data === 'string') handlers.text(data, now);
			else if (data instanceof ArrayBuffer && data.byteLength > 0) handlers.binary(data, now);
		};
		ws.onclose = (ev) => {
			if (this.closed) return;
			this.detach();
			handlers.close(ev.code);
		};
		ws.onerror = () => {
			// onclose follows
		};
	}

	get isOpen(): boolean {
		return !this.closed && this.ws.readyState === WebSocket.OPEN;
	}

	sendText(data: string): void {
		if (!this.isOpen) return;
		this.ws.send(data);
	}

	sendBinary(data: ArrayBuffer): void {
		if (!this.isOpen) return;
		this.ws.send(data);
	}

	close(): void {
		if (this.closed) return;
		this.detach();
		try {
			this.ws.close();
		} catch {
			// ignore
		}
	}

	private detach(): void {
		this.closed = true;
		this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
	}
}

export const createWsTransport: NetTransportFactory = (url, handlers) => {
	try {
		return new WsNetTransport(url, handlers);
	} catch {
		return null;
	}
};
