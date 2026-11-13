import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import { Http } from "../http/index.ts";
import { newToken } from "./secrets.ts";
import { SignIns } from "./sign-ins.ts";
export type EphemeralUser = { readonly kind: "user"; readonly id: string; readonly name: string };
export function ephemeralLoginFacet<P extends Principal>(
	..._fits: EphemeralUser extends P ? [] : ["the app's principal type must hold { kind: 'user', id, name }"]
): Facet<P> {
	return defineFacet<P>((_host, self) =>
		self.contribute(Http, {
			routes: {
				"POST /_objects/login": {
					public: true,
					handler: async (request, context) => {
						const body = (await request.json(4096)) as { name?: unknown } | null,
							name = typeof body?.name === "string" ? body.name.trim().slice(0, 40) : "";
						if (!name) return { kind: "error", status: 400 };
						const principal: EphemeralUser = { kind: "user", id: newToken(12), name },
							signIns = await context.get(SignIns, {}),
							issued = await signIns.issue(
								{ principal, label: name, kind: "ephemeral", secure: request.provenance.kind !== "local" },
								context,
							);
						return { kind: "json", value: principal, headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		}),
	);
}
