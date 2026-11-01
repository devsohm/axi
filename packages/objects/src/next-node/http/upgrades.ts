import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { withAbortSignal, withoutAbortSignal, type Context } from "../../context/index.ts";
import type { Principal } from "../../next/data/index.ts";
import type { Host } from "../../next/host/index.ts";
import { webSocketLink, type WebSocketLike, type PartLimits } from "../../next/link/index.ts";
import type { HttpRequest } from "./request.ts";
import type { HttpRelay, HttpSocket, Router, SocketMatch } from "./router.ts";
export type Admission<P extends Principal> = {
	readonly allowed: string | undefined;
	readonly relay: HttpRelay | undefined;
	readonly principal: P;
};
export type LinkOptions = { readonly limits?: PartLimits; readonly maxPayload?: number };
export type SocketFailure = { readonly pattern: string; readonly plugin: string; readonly error: unknown };
type Open = {
	socket: WebSocket;
	allowed: string | undefined;
	relay: HttpRelay | undefined;
	handler: HttpSocket | undefined;
	seal: () => void;
};
export class Upgrades {
	readonly #sockets = new Set<Open>();
	#keep(entry: Open): void {
		entry.socket.on("error", () => entry.socket.terminate());
		entry.socket.once("close", () => this.#sockets.delete(entry));
		this.#sockets.add(entry);
	}
	link<P extends Principal>(
		message: IncomingMessage,
		stream: Duplex,
		head: Buffer,
		admission: Admission<P> & LinkOptions,
		host: Host<P>,
		context: Context,
	): void {
		accept(message, stream, head, admission.maxPayload ?? 1024 * 1024, (socket) => {
			const link = webSocketLink(limitedSocket(socket));
			this.#keep({
				socket,
				allowed: admission.allowed,
				relay: admission.relay,
				handler: undefined,
				seal: () => link.close(),
			});
			host.accept(
				link,
				{ principal: admission.principal, ...(admission.limits === undefined ? {} : { limits: admission.limits }) },
				context,
			);
		});
	}
	socket<P extends Principal>(
		message: IncomingMessage,
		stream: Duplex,
		head: Buffer,
		admission: Admission<P> & { readonly match: SocketMatch; readonly request: HttpRequest },
		host: Host<P>,
		context: Context,
		failed: (failure: SocketFailure) => void,
	): void {
		const { match, request, principal } = admission;
		accept(message, stream, head, match.maxPayload, (socket) => {
			const controller = new AbortController(),
				seal = (): void => controller.abort(new Error("http: the socket closed"));
			socket.once("close", seal);
			this.#keep({ socket, allowed: admission.allowed, relay: admission.relay, handler: match.handler, seal });
			heartbeat(socket);
			void host
				.root(
					async (ctx) => {
						try {
							await match.handler(socket, request, ctx);
						} catch (error) {
							failed({ pattern: match.pattern, plugin: match.plugin, error });
							socket.close(1011, "internal error");
							return;
						}
						if (!controller.signal.aborted)
							await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
					},
					withAbortSignal(controller.signal, withoutAbortSignal(context)),
					{ principal },
				)
				.catch(() => {});
		});
	}
	revoke(router: Router): void {
		for (const entry of this.#sockets)
			if (
				(entry.allowed !== undefined && !router.hosts.has(entry.allowed)) ||
				(entry.relay !== undefined && !router.relays.includes(entry.relay)) ||
				(entry.handler !== undefined && !router.socketHandlers.has(entry.handler))
			)
				terminate(entry);
	}
	async close(deadline: Promise<void>): Promise<void> {
		const closing = [...this.#sockets].map(({ socket }) => {
			const done = new Promise<void>((resolve) => {
				if (socket.readyState === socket.CLOSED) resolve();
				else socket.once("close", () => resolve());
			});
			socket.close(1001, "going away");
			return done;
		});
		await Promise.race([Promise.all(closing), deadline]);
		for (const entry of this.#sockets) terminate(entry);
	}
}
function terminate(entry: Open): void {
	entry.socket.terminate();
	entry.seal();
}
function accept(
	message: IncomingMessage,
	stream: Duplex,
	head: Buffer,
	size: number,
	then: (socket: WebSocket) => void,
): void {
	new WebSocketServer({
		noServer: true,
		clientTracking: false,
		perMessageDeflate: false,
		maxPayload: size,
	}).handleUpgrade(message, stream, head, then);
}
function heartbeat(socket: WebSocket): void {
	let awaiting = false;
	const timer = setTimeout(() => {
		if (awaiting) socket.terminate();
		else {
			awaiting = true;
			socket.ping();
			timer.refresh();
		}
	}, 15000);
	timer.unref();
	const heard = (): void => {
		awaiting = false;
		timer.refresh();
	};
	for (const event of ["message", "ping", "pong"] as const) socket.on(event, heard);
	socket.once("close", () => clearTimeout(timer));
}
export function limitedSocket(socket: WebSocket): WebSocketLike {
	const pending = new Set<{ size: number }>();
	return {
		get readyState() {
			return socket.readyState;
		},
		get binaryType() {
			return socket.binaryType;
		},
		set binaryType(value: string) {
			socket.binaryType = value as WebSocket["binaryType"];
		},
		send(data) {
			if (socket.readyState !== socket.OPEN) return;
			let largest = 0;
			for (const entry of pending) largest = Math.max(largest, entry.size);
			if (socket.bufferedAmount - largest > 4 * 1024 * 1024) {
				socket.terminate();
				return;
			}
			const entry = { size: data.byteLength + 10 };
			pending.add(entry);
			socket.send(data, (error) => {
				pending.delete(entry);
				if (error) socket.terminate();
			});
		},
		close: () => socket.close(),
		addEventListener: (type: string, listener: (event: { readonly data: unknown }) => void) =>
			socket.addEventListener(type as "message", listener as never),
		removeEventListener: (type: string, listener: (event: { readonly data: unknown }) => void) =>
			socket.removeEventListener(type as "message", listener as never),
	} as WebSocketLike;
}
