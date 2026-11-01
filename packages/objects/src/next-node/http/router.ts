import type { WebSocket } from "ws";
import type { Ctx } from "../../next/host/index.ts";
import { defineRegistry, type ComposeContext, type RegistryTable } from "../../next/registries/index.ts";
import type { HttpRequest } from "./request.ts";
import type { HttpResponse } from "./response.ts";
export type HttpRoute = (request: HttpRequest, ctx: Ctx) => Promise<HttpResponse>;
export type HttpRouteOptions = { readonly handler: HttpRoute; readonly page?: true; readonly crossSite?: true };
export type WrapPhase = "observe" | "headers" | "transform";
export type HttpWrap = {
	readonly name: string;
	readonly phase: WrapPhase;
	readonly scope?: "own" | "all";
	readonly route?: string;
	readonly wrap: (
		request: HttpRequest,
		next: (request: HttpRequest) => Promise<HttpResponse>,
		ctx: Ctx,
	) => Promise<HttpResponse>;
};
export type WebSocketHandle = WebSocket;
export type HttpSocket = (socket: WebSocketHandle, request: HttpRequest, ctx: Ctx) => void | Promise<void>;
export type HttpRelay = {
	readonly name: string;
	readonly verify: (request: Request) => { readonly origin: string; readonly framer?: string } | undefined;
};
export type HttpContribution = {
	readonly routes?: Readonly<Record<string, HttpRoute | HttpRouteOptions>>;
	readonly wraps?: readonly HttpWrap[];
	readonly sockets?: Readonly<Record<string, HttpSocket>>;
	readonly maxPayload?: number;
	readonly hosts?: readonly string[];
	readonly framers?: readonly string[];
	readonly relays?: readonly HttpRelay[];
	readonly csp?: Readonly<Record<string, readonly string[]>>;
};
export type ResolvedWrap = { readonly wrap: HttpWrap; readonly plugin: string };
export type RouteMatch = {
	readonly pattern: string;
	readonly plugin: string;
	readonly params: Readonly<Record<string, string>>;
	readonly handler: HttpRoute;
	readonly page: boolean;
	readonly crossSite: boolean;
	readonly wraps: readonly ResolvedWrap[];
};
export type SocketMatch = {
	readonly pattern: string;
	readonly plugin: string;
	readonly params: Readonly<Record<string, string>>;
	readonly handler: HttpSocket;
	readonly maxPayload: number;
};
export type Router = {
	route(method: string, path: string): RouteMatch | "bad_path" | undefined;
	socket(path: string): SocketMatch | "bad_path" | undefined;
	readonly hosts: ReadonlySet<string>;
	readonly framers: ReadonlySet<string>;
	readonly relays: readonly HttpRelay[];
	readonly csp: ReadonlyMap<string, readonly string[]>;
	readonly socketHandlers: ReadonlySet<HttpSocket>;
};
export const Http = defineRegistry<HttpContribution, Router>("objects.http", { version: 1 });
export const UNCARRIED: ReadonlySet<string> = new Set(["TRACE", "TRACK", "CONNECT"]);
type Pattern = { readonly segments: readonly string[] };
type Entry<T> = { fixed: Map<string, Entry<T>>; parameter?: Entry<T>; terminal?: T; remainder?: T };
const node = <T>(): Entry<T> => ({ fixed: new Map() });
type RouteEntry = Omit<RouteMatch, "params" | "wraps"> & Pattern & { wraps: readonly ResolvedWrap[] };
type SocketEntry = Omit<SocketMatch, "params"> & Pattern;
function pattern(value: string): string[] | undefined {
	if (!value.startsWith("/")) return;
	const parts = value.slice(1).split("/");
	if (parts.some((part, index) => part === ":" || (part === "*" && index !== parts.length - 1))) return;
	return parts;
}
function insert<T extends Pattern>(root: Entry<T>, value: T): T | undefined {
	let current = root;
	for (const part of value.segments) {
		if (part === "*") {
			const old = current.remainder;
			current.remainder ??= value;
			return old;
		}
		if (part.startsWith(":")) current = current.parameter ??= node();
		else {
			let next = current.fixed.get(part);
			if (!next) {
				next = node();
				current.fixed.set(part, next);
			}
			current = next;
		}
	}
	const old = current.terminal;
	current.terminal ??= value;
	return old;
}
function match<T extends Pattern>(
	root: Entry<T> | undefined,
	path: string,
): (Omit<T, "segments"> & { readonly params: Readonly<Record<string, string>> }) | "bad_path" | undefined {
	if (!root) return;
	let parts: string[];
	try {
		parts = path
			.slice(1)
			.split("/")
			.map((part) => (part.includes("%") ? decodeURIComponent(part) : part));
	} catch {
		return "bad_path";
	}
	function search(current: Entry<T>, at: number): T | undefined {
		if (at === parts.length) return current.terminal ?? current.remainder;
		const exact = current.fixed.get(parts[at]!);
		return (
			(exact && search(exact, at + 1)) ??
			(parts[at] && current.parameter ? search(current.parameter, at + 1) : undefined) ??
			current.remainder
		);
	}
	const found = search(root, 0);
	if (!found) return;
	const params: Record<string, string> = {};
	const safe = (value: string): boolean => value !== "." && value !== ".." && !/[/\\\0]/.test(value);
	for (const [index, segment] of found.segments.entries()) {
		if (segment === "*") {
			const rest = parts.slice(index);
			if (!rest.every(safe)) return "bad_path";
			params["*"] = rest.join("/");
		} else if (segment.startsWith(":")) {
			const value = parts[index]!;
			if (!safe(value)) return "bad_path";
			params[segment.slice(1)] = value;
		}
	}
	const { segments: _segments, ...entry } = found;
	return { ...entry, params };
}
export function composeRouter(table: RegistryTable<HttpContribution>, { report }: ComposeContext): Router {
	const methods = new Map<string, Entry<RouteEntry>>(),
		sockets = node<SocketEntry>();
	const entries: RouteEntry[] = [],
		wraps: ResolvedWrap[] = [];
	const hosts = new Set<string>(),
		framers = new Set<string>(),
		socketHandlers = new Set<HttpSocket>();
	const relays: HttpRelay[] = [],
		csp = new Map<string, string[]>();
	for (const { plugin, value } of table) {
		for (const host of value.hosts ?? []) hosts.add(host.toLowerCase());
		for (const framer of value.framers ?? []) framers.add(framer);
		relays.push(...(value.relays ?? []));
		for (const [name, sources] of Object.entries(value.csp ?? {}))
			csp.set(name, [...(csp.get(name) ?? []), ...sources]);
		for (const wrap of value.wraps ?? []) wraps.push({ plugin, wrap });
		for (const [key, route] of Object.entries(value.routes ?? {})) {
			const space = key.indexOf(" "),
				method = key.slice(0, space),
				segments = pattern(key.slice(space + 1));
			if (space < 1 || !/^[A-Z]+$/.test(method) || !segments) {
				report({ message: `route "${key}" is no "METHOD /pattern"`, plugins: [plugin] });
				continue;
			}
			if (UNCARRIED.has(method)) {
				report({ message: `route "${key}": ${method} is served for no resource (501)`, plugins: [plugin] });
				continue;
			}
			let tree = methods.get(method);
			if (!tree) {
				tree = node();
				methods.set(method, tree);
			}
			const options = typeof route === "function" ? { handler: route } : route;
			const entry: RouteEntry = {
				pattern: key,
				plugin,
				segments,
				handler: options.handler,
				page: options.page === true,
				crossSite: options.crossSite === true,
				wraps: [],
			};
			const old = insert(tree, entry);
			if (old) report({ message: `route "${key}" is contributed twice`, plugins: [old.plugin, plugin] });
			else entries.push(entry);
		}
		for (const [path, handler] of Object.entries(value.sockets ?? {})) {
			const segments = pattern(path);
			if (!segments) {
				report({ message: `socket "${path}" is no pattern`, plugins: [plugin] });
				continue;
			}
			const old = insert(sockets, {
				pattern: path,
				plugin,
				handler,
				segments,
				maxPayload: value.maxPayload ?? 1024 * 1024,
			});
			if (old) report({ message: `socket "${path}" is contributed twice`, plugins: [old.plugin, plugin] });
			else socketHandlers.add(handler);
		}
	}
	const phases: WrapPhase[] = ["observe", "headers", "transform"];
	wraps.sort((a, b) => phases.indexOf(a.wrap.phase) - phases.indexOf(b.wrap.phase));
	for (const { plugin, wrap } of wraps)
		if (wrap.route !== undefined && !entries.some((entry) => entry.pattern === wrap.route))
			report({
				message: `wrap "${wrap.name}" names route "${wrap.route}", which nobody contributes`,
				plugins: [plugin],
			});
	for (const entry of entries)
		entry.wraps = wraps.filter(
			({ plugin, wrap }) =>
				(wrap.scope === "all" || plugin === entry.plugin) && (wrap.route === undefined || wrap.route === entry.pattern),
		);
	return {
		route(method, path) {
			const found =
				match(methods.get(method), path) ?? (method === "HEAD" ? match(methods.get("GET"), path) : undefined);
			if (found === undefined || found === "bad_path") return found;
			return found;
		},
		socket: (path) => match(sockets, path),
		hosts,
		framers,
		relays,
		csp,
		socketHandlers,
	};
}
