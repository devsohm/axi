import { randomInt } from "node:crypto";
import type { Principal } from "../../data/index.ts";
import { samePrincipal } from "../../data/principal.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import { Http, type HttpRequest, type HttpResponse } from "../http/index.ts";
import { hashToken, newToken } from "./secrets.ts";
import { SignIns } from "./sign-ins.ts";
export type PairingStarter = { readonly kind: "owner" } | { readonly kind: "anonymous"; readonly address: string };
export type PairingLimits = { readonly maxPending?: number; readonly perAddress?: number };
type Pairing = {
	readonly code: string;
	readonly label: string;
	readonly by: PairingStarter;
	readonly expires: number;
	token?: string;
};
export class Pairings {
	readonly #codes = new Map<string, Pairing>();
	readonly #polls = new Map<string, Pairing>();
	readonly #limits: PairingLimits;
	constructor(limits: PairingLimits = {}) {
		this.#limits = limits;
	}
	#prune(): void {
		for (const [hash, value] of this.#polls)
			if (value.expires <= Date.now()) {
				this.#polls.delete(hash);
				this.#codes.delete(value.code);
			}
	}
	begin(label: string, by: PairingStarter): { readonly code: string; readonly poll: string } | undefined {
		this.#prune();
		if (by.kind === "anonymous") {
			const anonymous = [...this.#codes.values()].filter((pairing) => pairing.by.kind === "anonymous");
			if (
				anonymous.length >= (this.#limits.maxPending ?? 100) ||
				anonymous.filter((pairing) => pairing.by.kind === "anonymous" && pairing.by.address === by.address).length >=
					(this.#limits.perAddress ?? 10)
			)
				return undefined;
		}
		const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789",
			part = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
		let code = part() + "-" + part();
		while (this.#codes.has(code)) code = part() + "-" + part();
		const poll = newToken(),
			value = { code, label, by, expires: Date.now() + 600_000 };
		this.#codes.set(code, value);
		this.#polls.set(hashToken(poll), value);
		return { code, poll };
	}
	waiting(code: string): Pairing | undefined {
		this.#prune();
		const value = this.#codes.get(code.toUpperCase());
		return value?.token === undefined ? value : undefined;
	}
	poll(poll: string): { readonly kind: "waiting" } | { readonly kind: "approved"; readonly token: string } | undefined {
		this.#prune();
		const hash = hashToken(poll),
			value = this.#polls.get(hash);
		if (!value) return undefined;
		if (value.token === undefined) return { kind: "waiting" };
		this.#polls.delete(hash);
		this.#codes.delete(value.code);
		return { kind: "approved", token: value.token };
	}
}
export const PAIR_PATH = "/_objects/pair";
const html = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
async function deviceLabel(request: HttpRequest): Promise<string> {
	if (Number(request.headers.get("content-length") ?? "0") === 0 && request.headers.get("transfer-encoding") === null)
		return "device";
	const body = (await request.json(4096)) as { label?: unknown } | null;
	return typeof body?.label === "string" && body.label.trim() ? body.label.trim().slice(0, 100) : "device";
}
export function pairingFacet<P extends Principal>(pairings: Pairings, owner: P): Facet<P> {
	return defineFacet<P>((_host, self) =>
		self.contribute(Http, {
			routes: {
				[`POST ${PAIR_PATH}`]: {
					public: true,
					handler: async (request, context) => {
						const result = pairings.begin(
							await deviceLabel(request),
							samePrincipal(context.principal, owner, context)
								? { kind: "owner" }
								: { kind: "anonymous", address: request.remoteAddress ?? "" },
						);
						return result ? { kind: "json", value: result } : { kind: "error", status: 429 };
					},
				},
				[`POST ${PAIR_PATH}/poll`]: {
					public: true,
					handler: async (request): Promise<HttpResponse> => {
						const body = (await request.json()) as { poll?: unknown } | null,
							result = typeof body?.poll === "string" ? pairings.poll(body.poll) : undefined;
						return !result
							? { kind: "error", status: 404 }
							: {
									kind: "json",
									value:
										result.kind === "waiting" ? { status: "waiting" } : { status: "approved", token: result.token },
								};
					},
				},
				[`GET ${PAIR_PATH}/:code`]: async (request, context) => {
					if (!samePrincipal(context.principal, owner, context)) return { kind: "error", status: 403 };
					const pairing = pairings.waiting(request.params.code ?? "");
					return pairing
						? {
								kind: "html",
								body: `<!doctype html><title>Pair a device</title>\n<p>Sign in <b>${html(pairing.label)}</b> as the owner? Its code: <b>${html(pairing.code)}</b> (compare it with the device).</p>\n<form method="post"><button>Approve</button></form>`,
							}
						: { kind: "html", status: 404, body: "<p>No such pairing (or it expired).</p>" };
				},
				[`POST ${PAIR_PATH}/:code`]: async (request, context) => {
					if (!samePrincipal(context.principal, owner, context)) return { kind: "error", status: 403 };
					const pairing = pairings.waiting(request.params.code ?? "");
					if (!pairing) return { kind: "html", status: 404, body: "<p>No such pairing (or it expired).</p>" };
					const signIns = await context.get(SignIns, {}),
						{ token } = await signIns.issue({ principal: owner, label: pairing.label, kind: "device" }, context);
					pairing.token = token;
					return { kind: "html", body: `<p>Approved: ${html(pairing.label)} is signed in as the owner.</p>` };
				},
			},
		}),
	);
}
