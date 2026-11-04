import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { awaitWithContext, withAbortSignal, withoutAbortSignal, type Context } from "../../context/index.ts";
import { local } from "../../next/contracts/index.ts";
import { isObjectsError, type Principal } from "../../next/data/index.ts";
import { defineFacet, type Host, type Facet, type Ctx } from "../../next/host/index.ts";
import type { RegistryValue } from "../../next/registries/index.ts";
import {
	admit,
	refused,
	isForeign,
	isNavigation,
	originAccepted,
	type Admitted,
	type Connection,
} from "./admission.ts";
import { Authenticators, composeAuthenticators, authenticate, type AuthenticatorEntry } from "./authenticate.ts";
import { DefaultHeaders, Nonces } from "./headers.ts";
import { webIncoming, type Incoming } from "./incoming.ts";
import { NodeIncoming, NodeListener, connectionOf, type ListenAddress, type Handler, type Served } from "./node.ts";
import { WebRequest, HttpFailure, type HttpRequest } from "./request.ts";
import { answerOf, errorAnswer, webResponse, type Answer, type HttpResponse } from "./response.ts";
import { Http, composeRouter, type Router, type RouteMatch } from "./router.ts";
import { Upgrades, type LinkOptions } from "./upgrades.ts";
export type HookName = "authenticate" | "relay" | "links.options";
export type HttpError =
	| { readonly kind: "route_failed"; readonly pattern: string; readonly plugin: string; readonly error: unknown }
	| { readonly kind: "wrap_failed"; readonly name: string; readonly plugin: string; readonly error: unknown }
	| { readonly kind: "socket_failed"; readonly pattern: string; readonly plugin: string; readonly error: unknown }
	| { readonly kind: "response_failed"; readonly pattern: string; readonly error: unknown }
	| { readonly kind: "hook_failed"; readonly hook: HookName; readonly plugin?: string; readonly error: unknown };
export type LinksOptions = {
	readonly path: string;
	readonly options?: LinkOptions | ((request: HttpRequest, principal: Principal) => LinkOptions);
};
export type HttpOptions = {
	readonly listen?: ListenAddress;
	readonly links?: LinksOptions;
	readonly closeTimeout?: number;
	readonly onError: (error: HttpError) => void;
};
export interface HttpComponent<P extends Principal> {
	readonly facet: Facet<P>;
	fetch(request: Request, connection?: Connection): Promise<Response>;
	readonly upgrade: (message: IncomingMessage, socket: Duplex, head: Buffer) => void;
	listening(context: Context): Promise<ListenAddress>;
	close(context: Context): Promise<void>;
}
export const HttpListener = local("objects.http.listener", { version: 1, params: {}, members: {} });
export function createHttp<P extends Principal>(
	host: Host<P>,
	options: HttpOptions,
	context: Context,
): HttpComponent<P> {
	return new ServerComponent(host, options, context);
}
type Registries = { router: RegistryValue<Router>; authenticators: RegistryValue<readonly AuthenticatorEntry[]> };
type Flight = { controller: AbortController; done: Promise<unknown> };
class ServerComponent<P extends Principal> implements HttpComponent<P>, Handler {
	readonly facet: Facet<P>;
	readonly upgrade: (message: IncomingMessage, socket: Duplex, head: Buffer) => void;
	readonly #host: Host<P>;
	readonly #options: HttpOptions;
	readonly #onError: HttpOptions["onError"];
	readonly #context: Context;
	readonly #base: Context;
	readonly #defaults = new DefaultHeaders();
	readonly #nonces = new Nonces();
	readonly #sockets = new Upgrades();
	readonly #flights = new Set<Flight>();
	readonly #closing = new AbortController();
	readonly #bound = Promise.withResolvers<ListenAddress>();
	#registries: Registries | undefined;
	#resolution: Promise<Registries> | undefined;
	#close: Promise<void> | undefined;
	constructor(host: Host<P>, options: HttpOptions, context: Context) {
		this.#host = host;
		this.#options = options;
		this.#onError = options.onError;
		this.#context = context;
		this.#base = withoutAbortSignal(context);
		this.#bound.promise.catch(() => {});
		this.upgrade = (message, socket, head) => {
			socket.on("error", () => socket.destroy());
			void this.#upgrade(message, socket, head).catch(() => socket.destroy());
		};
		this.facet = defineFacet<P>((facet) => {
			facet.serve(Http, { compose: composeRouter });
			facet.serve(Authenticators, { compose: composeAuthenticators });
			if (options.listen === undefined) return;
			const address = options.listen;
			facet.serve(HttpListener, (_params, self) => {
				self.open(
					async (opening) => {
						const listener = await NodeListener.listen(this, address, opening);
						this.#bound.resolve(listener.address);
						return listener;
					},
					async (listener, _reason, closing) => {
						listener.stop();
						await this.close(closing);
						await listener.closed();
					},
				);
				return {};
			});
		});
	}
	async fetch(request: Request, connection: Connection = {}): Promise<Response> {
		const { answer, finished } = await this.serve(webIncoming(request), connection);
		if (answer.body instanceof ReadableStream) return webResponse({ ...answer, body: track(answer.body, finished) });
		finished();
		return webResponse(answer);
	}
	listening(context: Context): Promise<ListenAddress> {
		return awaitWithContext(this.#bound.promise, context);
	}
	close(context: Context): Promise<void> {
		return (this.#close ??= this.#finish(context));
	}
	refusal(status: number, admission?: Admitted, router?: Router, head = false): Answer {
		return errorAnswer(status, this.#defaults.of(admission, router, this.#nonces.next()), undefined, head);
	}
	async serve(incoming: Incoming, connection: Connection): Promise<Served> {
		const end = Promise.withResolvers<void>(),
			controller = new AbortController();
		const flight: Flight = { controller, done: end.promise };
		this.#flights.add(flight);
		incoming.cancelled((reason) => controller.abort(reason));
		let answer: Answer;
		try {
			const result = await this.#request(incoming, connection, controller.signal, end.promise);
			answer = result.answer;
			if (result.scope) flight.done = Promise.all([end.promise, result.scope]);
		} catch {
			answer = this.refusal(500);
		}
		void flight.done.then(() => this.#flights.delete(flight));
		return { answer, finished: () => end.resolve() };
	}
	#resolve(): Promise<Registries> {
		return (this.#resolution ??= Promise.all([
			this.#host.registry(Http, this.#context),
			this.#host.registry(Authenticators, this.#context),
		]).then(
			([router, authenticators]) => {
				this.#registries = { router, authenticators };
				void this.#watch(router).catch(() => {});
				return this.#registries;
			},
			(error) => {
				this.#resolution = undefined;
				throw error;
			},
		));
	}
	async #watch(router: RegistryValue<Router>): Promise<void> {
		if (this.#closing.signal.aborted) return;
		const watch = await router.watch(withAbortSignal(this.#closing.signal, this.#base));
		if (!this.#closing.signal.aborted)
			watch.start(async (call) => {
				if (call.kind === "value") this.#sockets.revoke(call.value);
			});
	}
	#hook(hook: HookName, plugin: string | undefined, error: unknown): void {
		this.#onError({ kind: "hook_failed", hook, ...(plugin === undefined ? {} : { plugin }), error });
	}
	async #principal(registries: Registries, request: HttpRequest, signal: AbortSignal): Promise<P | undefined> {
		const context = withAbortSignal(signal, this.#base);
		return (await awaitWithContext(
			authenticate(
				registries.authenticators.value,
				request,
				(plugin, error) => this.#hook("authenticate", plugin, error),
				context,
			),
			context,
		).catch(() => undefined)) as P | undefined;
	}
	async #request(
		incoming: Incoming,
		connection: Connection,
		signal: AbortSignal,
		done: Promise<void>,
	): Promise<{ answer: Answer; scope?: Promise<void> }> {
		const head = incoming.method === "HEAD";
		if (this.#closing.signal.aborted) return { answer: this.refusal(503, undefined, undefined, head) };
		let registries: Registries;
		try {
			registries = this.#registries ?? (await this.#resolve());
		} catch {
			return { answer: this.refusal(503, undefined, undefined, head) };
		}
		if (this.#closing.signal.aborted) return { answer: this.refusal(503, undefined, undefined, head) };
		const router = registries.router.value,
			admission = admit(incoming, connection, router.hosts, router.relays);
		if (refused(admission)) {
			if (admission.failed) this.#hook("relay", admission.failed.relay, admission.failed.error);
			return { answer: this.refusal(403, undefined, router, head) };
		}
		const request = new WebRequest(incoming, admission, this.#nonces.next()),
			match = router.route(incoming.method, request.path);
		if (match === undefined || match === "bad_path")
			return { answer: this.refusal(match === undefined ? 404 : 400, admission, router, head) };
		request.params = match.params;
		if (!match.crossSite && !originAccepted(incoming.method, incoming, admission.origin))
			return { answer: this.refusal(403, admission, router, head) };
		const foreign = isForeign(incoming);
		let principal: P | undefined;
		if (
			registries.authenticators.value.length &&
			!match.crossSite &&
			(!foreign || (match.page && isNavigation(incoming.method, incoming)))
		) {
			principal = await this.#principal(registries, request, signal);
			if (this.#closing.signal.aborted || signal.aborted) return { answer: this.refusal(503, admission, router, head) };
		}
		const delivered = Promise.withResolvers<Answer>();
		const scope = this.#host
			.root(
				async (ctx) => {
					delivered.resolve(await this.#answer(incoming, request, match, admission, router, foreign, ctx));
					await done;
				},
				withAbortSignal(signal, this.#base),
				{ principal },
			)
			.catch(() => {
				delivered.resolve(this.refusal(503, admission, router, head));
			});
		return { answer: await delivered.promise, scope };
	}
	async #answer(
		incoming: Incoming,
		request: WebRequest,
		match: RouteMatch,
		admission: Admitted,
		router: Router,
		foreign: boolean,
		ctx: Ctx<P>,
	): Promise<Answer> {
		let response: HttpResponse;
		try {
			response = await execute(match, request, ctx);
		} catch (error) {
			const failure = error instanceof ChainFailure ? error : new ChainFailure(match.plugin, undefined, error);
			if (failure.cause instanceof HttpFailure) response = { kind: "error", status: failure.cause.status };
			else if (isObjectsError(failure.cause, "forbidden")) response = { kind: "error", status: 403 };
			else {
				if (failure.wrap === undefined)
					this.#onError({
						kind: "route_failed",
						pattern: match.pattern,
						plugin: failure.plugin,
						error: failure.cause,
					});
				else
					this.#onError({
						kind: "wrap_failed",
						name: failure.wrap,
						plugin: failure.plugin,
						error: failure.cause,
					});
				response = { kind: "error", status: 500 };
			}
		}
		if (foreign && response.kind === "bytes") response = { kind: "error", status: 403 };
		const failed = (error: unknown): void => this.#onError({ kind: "response_failed", pattern: match.pattern, error });
		try {
			return answerOf(response, incoming, this.#defaults.of(admission, router, request.nonce), ctx, failed);
		} catch (error) {
			failed(error);
			return this.refusal(500, admission, router, request.method === "HEAD");
		}
	}
	async #upgrade(message: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		const controller = new AbortController(),
			gone = (): void => controller.abort(new Error("http: the client disconnected"));
		if (socket.destroyed) gone();
		else {
			socket.once("close", gone);
			socket.once("end", gone);
			socket.read(0);
		}
		const flight: Flight = { controller, done: this.#upgradeRequest(message, socket, head, controller.signal) };
		this.#flights.add(flight);
		try {
			await flight.done;
		} finally {
			this.#flights.delete(flight);
			socket.removeListener("close", gone);
			socket.removeListener("end", gone);
		}
	}
	async #upgradeRequest(message: IncomingMessage, socket: Duplex, head: Buffer, signal: AbortSignal): Promise<void> {
		if (this.#closing.signal.aborted) return rejectUpgrade(socket, 503);
		const incoming = NodeIncoming.of(message);
		if (!(incoming instanceof NodeIncoming)) return rejectUpgrade(socket, incoming.status);
		let registries: Registries;
		try {
			registries = this.#registries ?? (await this.#resolve());
		} catch {
			return rejectUpgrade(socket, 503);
		}
		if (this.#closing.signal.aborted || signal.aborted) return rejectUpgrade(socket, 503);
		const admission = admit(
			incoming,
			connectionOf(message),
			registries.router.value.hosts,
			registries.router.value.relays,
		);
		if (refused(admission)) {
			if (admission.failed) this.#hook("relay", admission.failed.relay, admission.failed.error);
			return rejectUpgrade(socket, 403);
		}
		const origin = incoming.header("origin");
		if (isForeign(incoming) || (origin !== null && origin !== admission.origin)) return rejectUpgrade(socket, 403);
		const request = new WebRequest(incoming, admission, this.#nonces.next()),
			principal = await this.#principal(registries, request, signal);
		if (this.#closing.signal.aborted || signal.aborted) return rejectUpgrade(socket, 503);
		if (principal === undefined) return rejectUpgrade(socket, 403);
		const router = registries.router.value,
			{ allowed, relay } = admission;
		if (
			(allowed !== undefined && !router.hosts.has(allowed)) ||
			(relay !== undefined && !router.relays.includes(relay))
		)
			return rejectUpgrade(socket, 403);
		const links = this.#options.links;
		if (links && request.path === links.path) {
			let options: LinkOptions;
			try {
				options = (typeof links.options === "function" ? links.options(request, principal) : links.options) ?? {};
			} catch (error) {
				this.#hook("links.options", undefined, error);
				return rejectUpgrade(socket, 403);
			}
			return this.#sockets.link(
				message,
				socket,
				head,
				{ allowed, relay, principal, ...options },
				this.#host,
				this.#context,
			);
		}
		const match = router.socket(request.path);
		if (match === undefined || match === "bad_path") return rejectUpgrade(socket, match === undefined ? 404 : 400);
		request.params = match.params;
		this.#sockets.socket(
			message,
			socket,
			head,
			{ allowed, relay, principal, match, request },
			this.#host,
			this.#context,
			(failure) => this.#onError({ kind: "socket_failed", ...failure }),
		);
	}
	async #finish(context: Context): Promise<void> {
		this.#closing.abort();
		this.#bound.reject(new Error("http: closed"));
		let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
		const deadline = new Promise<void>((resolve) => {
			if (context.abortSignal?.aborted) {
				resolve();
				return;
			}
			timer = setTimeout(resolve, this.#options.closeTimeout ?? 30000);
			abort = resolve;
			context.abortSignal?.addEventListener("abort", abort, { once: true });
		});
		await Promise.race([
			Promise.all([this.#sockets.close(deadline), ...Array.from(this.#flights, (flight) => flight.done)]),
			deadline,
		]);
		clearTimeout(timer);
		if (abort) context.abortSignal?.removeEventListener("abort", abort);
		for (const flight of this.#flights) flight.controller.abort(new Error("http: closed"));
	}
}
function track(stream: ReadableStream<Uint8Array>, finished: () => void): ReadableStream<Uint8Array> {
	const reader = stream.getReader();
	reader.closed.then(finished, finished);
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const chunk = await reader.read();
					if (chunk.done) {
						controller.close();
						finished();
					} else controller.enqueue(chunk.value);
				} catch (error) {
					controller.error(error);
					finished();
				}
			},
			async cancel(reason) {
				finished();
				await reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}
function rejectUpgrade(socket: Duplex, status: number): void {
	socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
class ChainFailure extends Error {
	readonly plugin: string;
	readonly wrap: string | undefined;
	constructor(plugin: string, wrap: string | undefined, cause: unknown) {
		super("thrown", { cause });
		this.plugin = plugin;
		this.wrap = wrap;
	}
}
async function execute(match: RouteMatch, request: HttpRequest, ctx: Ctx): Promise<HttpResponse> {
	const handler = match.handler;
	let call = async (request: HttpRequest): Promise<HttpResponse> => {
		try {
			return await handler(request, ctx);
		} catch (error) {
			throw new ChainFailure(match.plugin, undefined, error);
		}
	};
	for (let index = match.wraps.length - 1; index >= 0; index--) {
		const inner = call,
			{ plugin, wrap } = match.wraps[index]!;
		call = async (request) => {
			try {
				return await wrap.wrap(request, inner, ctx);
			} catch (error) {
				if (error instanceof ChainFailure) throw error;
				throw new ChainFailure(plugin, wrap.name, error);
			}
		};
	}
	return call(request);
}
