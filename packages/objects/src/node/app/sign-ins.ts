import type { Context } from "../../context/index.ts";
import { arr, bool, local, map, method, num, obj, oneOf, opt, str, unknown } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineState } from "../../documents/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import {
	Authenticators,
	cookie,
	Http,
	readCookie,
	readSignedCookie,
	type HttpRequest,
	type HttpWrap,
} from "../http/index.ts";
import { EphemeralSignIns } from "./ephemeral-sign-ins.ts";
import { hashToken, matchesHash, newToken } from "./secrets.ts";

export type SignInKind = "browser" | "device" | "ephemeral";
export type SignInInfo = {
	readonly id: string;
	readonly label: string;
	readonly kind: "browser" | "device";
	readonly principal: unknown;
	readonly created: number;
	readonly lastUsed: number;
};
export const SignIns = local("objects.app.sign-ins", {
	version: 1,
	params: {},
	members: {
		list: arr(
			obj({
				id: str(),
				label: str(),
				kind: oneOf("browser", "device"),
				principal: unknown(),
				created: num(),
				lastUsed: num(),
			}),
		),
		issue: method(
			obj({ principal: unknown(), label: str(), kind: oneOf("browser", "device", "ephemeral"), secure: opt(bool()) }),
			obj({ id: str(), token: str(), cookie: str() }),
		),
		verify: method(str(), unknown()),
		revoke: method(str()),
	},
});
export const SIGN_IN_COOKIE = "objects-sign-in";
const idle = 400 * 24 * 60 * 60_000;
const StoredSignIns = defineState("objects.app.sign-ins", {
	version: 1,
	schema: obj({
		signIns: map(
			obj({
				hash: str(),
				label: str(),
				kind: oneOf("browser", "device"),
				principal: str(),
				created: num(),
				lastUsed: num(),
			}),
		),
	}),
	persist: true,
	initial: () => ({ signIns: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});
export type SignInLimits = { readonly maxEphemeral?: number };
export type KitSignIns<P extends Principal> = {
	readonly facet: Facet<P>;
	readonly opened: (request: HttpRequest) => (() => void) | undefined;
};
function bearer(request: HttpRequest): string | undefined {
	return /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
}
function tokenCookie(
	token: string,
	kind: SignInKind,
	request: Pick<HttpRequest, "provenance">,
	secret: string,
): string {
	return cookie(SIGN_IN_COOKIE, token, { request, secret, maxAge: kind === "ephemeral" ? undefined : idle / 1000 });
}
function rolling(secret: string, authenticate: (token: string, context: Context) => Principal | undefined): HttpWrap {
	return {
		name: "objects.app.rolling-cookie",
		phase: "headers",
		scope: "all",
		async wrap(request, next, context) {
			const response = await next(request);
			if (
				!context.principal ||
				Object.keys(response.headers ?? {}).some((header) => header.toLowerCase() === "set-cookie")
			)
				return response;
			const current = readSignedCookie(request, SIGN_IN_COOKIE, secret);
			if (
				current?.expires === undefined ||
				current.expires - Date.now() > idle - 24 * 60 * 60_000 ||
				authenticate(current.value, context) === undefined
			)
				return response;
			return {
				...response,
				headers: { ...response.headers, "Set-Cookie": tokenCookie(current.value, "browser", request, secret) },
			};
		},
	};
}
export function createSignIns<P extends Principal>(cookieSecret: string, limits: SignInLimits = {}): KitSignIns<P> {
	const ephemeral = new EphemeralSignIns(limits.maxEphemeral ?? 1000);
	const facet = defineFacet<P>((host) =>
		host.serve(SignIns, (_params, self) => {
			const state = self.state(StoredSignIns);
			const verify = (token: string, context: Context): Principal | undefined => {
				const dot = token.indexOf(".");
				if (dot <= 0) return undefined;
				const id = token.slice(0, dot),
					secret = token.slice(dot + 1),
					transient = ephemeral.get(id);
				if (transient) return matchesHash(secret, transient.hash) ? transient.principal : undefined;
				const stored = state.value.signIns;
				if (!Object.hasOwn(stored, id)) return undefined;
				const session = stored[id]!;
				if (!matchesHash(secret, session.hash)) return undefined;
				const now = Date.now(),
					expired = now - session.lastUsed > idle;
				if (expired || now - session.lastUsed > 60_000)
					void state
						.change((draft) => {
							if (expired) delete draft.signIns[id];
							else if (Object.hasOwn(draft.signIns, id)) draft.signIns[id]!.lastUsed = now;
						}, context)
						.catch(() => {});
				return expired ? undefined : (JSON.parse(session.principal) as Principal);
			};
			self.contribute(Authenticators, (request, context) => {
				const token = bearer(request) ?? readCookie(request, SIGN_IN_COOKIE, cookieSecret);
				return token === undefined ? undefined : verify(token, context);
			});
			self.contribute(Http, { wraps: [rolling(cookieSecret, verify)] });
			return {
				list: self.derive([state], ([value]) =>
					Object.entries(value.signIns).map(([id, session]) => ({
						id,
						label: session.label,
						kind: session.kind,
						principal: JSON.parse(session.principal) as JsonValue,
						created: session.created,
						lastUsed: session.lastUsed,
					})),
				),
				issue: async ({ principal, label, kind, secure }, context) => {
					const id = newToken(12),
						secret = newToken(32),
						hash = hashToken(secret),
						now = Date.now();
					if (kind === "ephemeral") ephemeral.issue(id, hash, principal as Principal);
					else
						await state.change((draft) => {
							draft.signIns[id] = {
								hash,
								label,
								kind,
								principal: JSON.stringify(principal),
								created: now,
								lastUsed: now,
							};
						}, context);
					const token = id + "." + secret;
					return {
						id,
						token,
						cookie: tokenCookie(
							token,
							kind,
							{ provenance: secure ? { kind: "remote", host: "" } : { kind: "local" } },
							cookieSecret,
						),
					};
				},
				verify: async (token, context) => (verify(token, context) as JsonValue | undefined) ?? null,
				revoke: async (id, context) => {
					if (!ephemeral.revoke(id))
						await state.change((draft) => {
							delete draft.signIns[id];
						}, context);
					return null;
				},
			};
		}),
	);
	return {
		facet,
		opened(request) {
			const token = bearer(request) ?? readCookie(request, SIGN_IN_COOKIE, cookieSecret),
				dot = token?.indexOf(".") ?? -1;
			return dot > 0 ? ephemeral.linkOpened(token!.slice(0, dot)) : undefined;
		},
	};
}
