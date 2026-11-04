import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { Http } from "../http/index.ts";
import { fragmentPage } from "./owner.ts";
import { hashToken, newToken } from "./secrets.ts";
import { Sessions } from "./sessions.ts";
export function inviteFacet<P extends Principal>(): Facet<P> {
	const waiting = new Map<string, { principal: JsonValue; label: string; expires: number }>(),
		path = "/_objects/invite";
	return defineFacet<P>((_host, self) =>
		self.contribute(Http, {
			routes: {
				"POST /_objects/invites": async (request, context) => {
					if (context.principal?.kind !== "owner") return { kind: "error", status: 403 };
					const body = (await request.json()) as { principal?: JsonValue; label?: unknown } | null;
					if (!body?.principal || typeof body.principal !== "object" || typeof body.label !== "string")
						return { kind: "error", status: 400 };
					const token = newToken();
					waiting.set(hashToken(token), {
						principal: body.principal,
						label: body.label,
						expires: Date.now() + 7 * 24 * 60 * 60_000,
					});
					return { kind: "json", value: { path: `${path}#${token}` } };
				},
				[`GET ${path}`]: {
					public: true,
					handler: async (request) => ({ kind: "html", body: fragmentPage(path, request.nonce) }),
				},
				[`POST ${path}`]: {
					public: true,
					handler: async (request, context) => {
						const body = (await request.json()) as { token?: unknown } | null,
							hash = typeof body?.token === "string" ? hashToken(body.token) : undefined,
							invite = hash === undefined ? undefined : waiting.get(hash);
						if (hash === undefined || !invite) return { kind: "error", status: 403 };
						waiting.delete(hash);
						if (invite.expires <= Date.now()) return { kind: "error", status: 403 };
						const sessions = await context.get(Sessions, {}),
							issued = await sessions.issue(
								{
									principal: invite.principal,
									label: invite.label,
									kind: "browser",
									secure: request.provenance.kind !== "local",
								},
								context,
							);
						return { kind: "json", value: "signed in", headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		}),
	);
}
