import { chmod } from "node:fs/promises";
import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import { samePrincipal } from "../../data/principal.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { Http } from "../http/index.ts";
import { hashToken, matchesHash, newToken, readSecret, writeSecret } from "./secrets.ts";
import { Sessions } from "./sessions.ts";
export const OWNER_PATH = "/_objects/owner";
export class OwnerLink {
	#current: { hash: string; expiry: number } | undefined;
	renew(): string {
		const token = newToken();
		this.#current = { hash: hashToken(token), expiry: Date.now() + 600_000 };
		return token;
	}
	consume(token: string): boolean {
		const current = this.#current;
		if (!current || !matchesHash(token, current.hash)) return false;
		this.#current = undefined;
		return Date.now() < current.expiry;
	}
}
export function fragmentPage(path: string, nonce: string): string {
	return `<!doctype html><title>Sign in</title><p id="status">Signing in…</p>\n<script nonce="${nonce}">\nconst token = location.hash.slice(1); history.replaceState(null, '', location.pathname);\nfetch(${JSON.stringify(path)}, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})}).then(response => {if(response.ok) location.replace('/'); else document.getElementById('status').textContent='This link is used up or expired.';});\n</script>`;
}
export function ownerFacet<P extends Principal>(link: OwnerLink, owner: P): Facet<P> {
	return defineFacet<P>((_host, self) =>
		self.contribute(Http, {
			routes: {
				[`GET ${OWNER_PATH}`]: {
					public: true,
					handler: async (request) => ({ kind: "html", body: fragmentPage(OWNER_PATH, request.nonce) }),
				},
				[`POST ${OWNER_PATH}`]: {
					public: true,
					handler: async (request, context) => {
						const body = (await request.json()) as { token?: unknown } | null;
						if (typeof body?.token !== "string" || !link.consume(body.token)) return { kind: "error", status: 403 };
						const sessions = await context.get(Sessions, {}),
							issued = await sessions.issue(
								{
								principal: owner,
									label: "owner browser",
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
export async function ownerTokenFile<P extends Principal>(
	path: string,
	owner: P,
	host: Host<P>,
	context: Context,
): Promise<string> {
	const previous = await readSecret(path);
	return host.root(async (ctx) => {
		const sessions = await ctx.get(Sessions, {}),
			principal = previous === undefined ? undefined : (await sessions.verify(previous, ctx)) as P | null;
		if (
			previous !== undefined &&
			samePrincipal(principal ?? undefined, owner, ctx)
		) {
			await chmod(path, 0o600);
			return previous;
		}
		if (previous !== undefined && principal != null) await sessions.revoke(previous.split(".", 1)[0]!, ctx);
		const { token } = await sessions.issue({ principal: owner, label: "owner token file", kind: "device" }, ctx);
		await writeSecret(path, token, previous === undefined ? "create" : "replace");
		return token;
	}, context);
}
