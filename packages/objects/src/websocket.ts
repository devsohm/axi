import type { AcceptOptions } from "./connection.ts";
import type { Host } from "./host.ts";
import { type WebSocketLike, webSocketLink } from "./link.ts";

export interface WebSocketServerLike<Request> {
	on(event: "connection", listener: (socket: WebSocketLike, request: Request) => void): unknown;
}
export interface WebSocketAcceptOptions<Request, P = unknown>
	extends Omit<AcceptOptions<P>, "principal" | "kind" | "name"> {
	principal(request: Request): P | undefined | Promise<P | undefined>;
}
export function acceptWebSockets<Request, P = unknown>(
	server: WebSocketServerLike<Request>,
	host: Host<P>,
	options: WebSocketAcceptOptions<Request, P>,
): void {
	server.on("connection", (socket, request) => {
		const link = webSocketLink(socket, { compress: true, acceptPacked: false });
		void Promise.resolve(options.principal(request)).then(
			(principal) => {
				if (principal === undefined) link.close("unauthorized");
				else host.accept(link, { ...options, principal, kind: "client" });
			},
			() => link.close("authentication failed"),
		);
	});
}
