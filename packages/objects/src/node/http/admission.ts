import type { Incoming } from "./incoming.ts";
import type { HttpRelay } from "./router.ts";

export type Provenance =
	| { readonly kind: "local" }
	| { readonly kind: "remote"; readonly host: string }
	| { readonly kind: "relayed"; readonly relay: string; readonly origin: string };
export type Connection = {
	readonly localAddress?: string;
	readonly localPort?: number;
	readonly remoteAddress?: string;
};
export type Admitted = {
	readonly provenance: Provenance;
	readonly origin: string;
	readonly framer: string | undefined;
	readonly allowed: string | undefined;
	readonly relay: HttpRelay | undefined;
};
export type Refused = {
	readonly kind: "refused";
	readonly failed?: { readonly relay: string; readonly error: unknown };
};
export type HeaderSource = Pick<Incoming, "header">;
const denied: Refused = { kind: "refused" };
function exactOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && url.origin === value;
	} catch {
		return false;
	}
}
export function admit(
	request: Incoming,
	connection: Connection,
	hosts: ReadonlySet<string>,
	relays: readonly HttpRelay[],
): Admitted | Refused {
	const host = request.header("host")?.toLowerCase();
	if (!host || host.includes(",")) return denied;
	const local =
		connection.localPort !== undefined &&
		["127.0.0.1", "localhost", "[::1]"].some(
			(name) => host === `${name}:${connection.localPort}` || (connection.localPort === 80 && host === name),
		);
	if (!local)
		return hosts.has(host)
			? {
					provenance: { kind: "remote", host },
					origin: `https://${host}`,
					framer: undefined,
					allowed: host,
					relay: undefined,
				}
			: denied;
	const address = connection.localAddress;
	if (!address || !(address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.")))
		return denied;
	if (!request.forwarded())
		return {
			provenance: { kind: "local" },
			origin: `http://${host}`,
			framer: undefined,
			allowed: undefined,
			relay: undefined,
		};
	for (const relay of relays) {
		try {
			const accepted = relay.verify(request.request());
			if (accepted === undefined) continue;
			for (const value of [accepted.origin, accepted.framer])
				if (value !== undefined && !exactOrigin(value))
					throw new Error(`relay ${relay.name}: ${JSON.stringify(value)} is no origin`);
			return {
				provenance: { kind: "relayed", relay: relay.name, origin: accepted.origin },
				origin: accepted.origin,
				framer: accepted.framer,
				allowed: undefined,
				relay,
			};
		} catch (error) {
			return { kind: "refused", failed: { relay: relay.name, error } };
		}
	}
	return denied;
}
export function refused(value: Admitted | Refused): value is Refused {
	return "kind" in value;
}
export function isForeign(source: HeaderSource): boolean {
	const site = source.header("sec-fetch-site");
	return (
		(site !== null && site !== "same-origin" && site !== "none") ||
		(site !== "same-origin" &&
			["iframe", "frame", "embed", "object", "fencedframe"].includes(source.header("sec-fetch-dest") ?? ""))
	);
}
export function isNavigation(method: string, source: HeaderSource): boolean {
	return (
		method === "GET" &&
		source.header("sec-fetch-mode") === "navigate" &&
		["document", "empty"].includes(source.header("sec-fetch-dest") ?? "")
	);
}
export function originAccepted(method: string, source: HeaderSource, origin: string): boolean {
	const sent = source.header("origin");
	return sent === null
		? ["GET", "HEAD", "OPTIONS"].includes(method) || source.header("sec-fetch-site") === null
		: sent === origin;
}
