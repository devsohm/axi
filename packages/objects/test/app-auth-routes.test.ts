import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../src/context/index.ts";
import { createHost, defineFacet, openStore, sqliteBackend } from "../src/index.ts";
import { ephemeralLoginFacet, type EphemeralUser } from "../src/node/app/ephemeral.ts";
import { appInfoFacet } from "../src/node/app/info.ts";
import { inviteFacet } from "../src/node/app/invite.ts";
import { createSessions, Sessions } from "../src/node/app/sessions.ts";
import { createHttp, Http, type HttpError } from "../src/node/http/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";

type Principal = EphemeralUser | { readonly kind: "server" } | { readonly kind: "owner" };

async function application() {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const host = createHost<Principal>({
		store,
		principal: { kind: "server" },
		onError(error) {
			throw error;
		},
	});
	const errors: HttpError[] = [];
	const http = createHttp(host, { onError: (error) => errors.push(error) }, context);
	expect(
		(
			await host.load(
				[
					{ name: "http", facet: http.facet },
					{ name: "sessions", facet: createSessions<Principal>("test-cookie-key").facet },
					{
						name: "info",
						facet: appInfoFacet<Principal>({
							name: "team",
							version: "v1",
							dataDir: "unused",
							owner: { kind: "owner" },
						}),
					},
					{ name: "login", facet: ephemeralLoginFacet<Principal>() },
					{ name: "invites", facet: inviteFacet<Principal>() },
					{
						name: "account",
						facet: defineFacet<Principal>((_host, self) =>
							self.contribute(Http, {
								hosts: ["team.example"],
								routes: { "GET /account": async (_request, ctx) => ({ kind: "json", value: ctx.principal ?? null }) },
							}),
						),
					},
				],
				context,
			)
		).failed,
	).toEqual([]);
	const sessions = await host.get(Sessions, {}, context);
	const owner = await sessions.issue({ principal: { kind: "owner" }, label: "owner", kind: "device" }, context);
	return {
		sessions,
		owner,
		request(path: string, body?: unknown, headers: HeadersInit = {}, remote = false) {
			const origin = remote ? "https://team.example" : "http://localhost:7315";
			return http.fetch(
				new Request(origin + path, {
					method: body === undefined ? "GET" : "POST",
					headers: { host: new URL(origin).host, "content-type": "application/json", ...headers },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
				{ localAddress: "127.0.0.1", localPort: 7315 },
			);
		},
		async [Symbol.asyncDispose]() {
			sessions.release();
			await http.close(context);
			await host.close(context);
			await store.close(context);
			expect(errors).toEqual([]);
		},
	};
}

test("ephemeral login validates and limits names, issues independent identities and authenticates their cookies", async () => {
	await using app = await application();
	for (const body of [null, {}, { name: 3 }, { name: " \n " }])
		expect((await app.request("/_objects/login", body)).status).toBe(400);
	const first = await app.request("/_objects/login", { name: `  ${"a".repeat(45)}  ` });
	expect(first.status).toBe(200);
	const identity = await first.json();
	expect(identity).toEqual({ kind: "user", id: expect.any(String), name: "a".repeat(40) });
	const cookie = first.headers.get("set-cookie")!;
	expect(cookie).toContain("HttpOnly");
	expect(cookie).not.toMatch(/(?:Max-Age|Secure)/i);
	expect(await (await app.request("/account", undefined, { cookie: cookie.split(";")[0]! })).json()).toEqual(identity);
	const second = await app.request("/_objects/login", { name: "a".repeat(40) }, {}, true);
	expect(second.headers.get("set-cookie")).toContain("Secure");
	expect((await second.json()).id).not.toBe(identity.id);
	expect(app.sessions.list.value.map(({ label }) => label)).toEqual(["owner"]);
});

test("only the owner can create invitations and malformed requests never issue a session", async () => {
	await using app = await application();
	const invitation = { principal: { kind: "user", id: "member", name: "Member" }, label: "Member browser" };
	expect((await app.request("/_objects/invites", invitation)).status).toBe(401);
	const guest = await app.sessions.issue({ principal: invitation.principal, kind: "device", label: "guest" }, context);
	expect((await app.request("/_objects/invites", invitation, { authorization: `Bearer ${guest.token}` })).status).toBe(
		403,
	);
	for (const body of [
		null,
		{},
		{ principal: null, label: "name" },
		{ principal: "name", label: "name" },
		{ principal: {}, label: 1 },
	])
		expect((await app.request("/_objects/invites", body, { authorization: `Bearer ${app.owner.token}` })).status).toBe(
			400,
		);
	expect(app.sessions.list.value).toHaveLength(2);
});

test("invitation pages redeem once, retain the invited identity and expire after seven days", async () => {
	await using app = await application();
	const principal = { kind: "user", id: "member", name: "Member" };
	async function invite() {
		const response = await app.request(
			"/_objects/invites",
			{ principal, label: "Member browser" },
			{
				authorization: `Bearer ${app.owner.token}`,
			},
		);
		expect(response.status).toBe(200);
		return new URL((await response.json()).path, "https://team.example");
	}
	const link = await invite();
	const page = await app.request(link.pathname);
	expect(page.headers.get("content-security-policy")).toContain("nonce-");
	const html = await page.text();
	expect(html).toContain("location.hash");
	expect(html).not.toContain(link.hash.slice(1));
	for (const body of [null, {}, { token: 1 }, { token: "unknown" }])
		expect((await app.request(link.pathname, body)).status).toBe(403);
	const response = await app.request(link.pathname, { token: link.hash.slice(1) }, {}, true);
	expect(response.status).toBe(200);
	expect(await response.json()).toBe("signed in");
	const cookie = response.headers.get("set-cookie")!;
	expect(cookie).toContain("Secure");
	expect(await (await app.request("/account", undefined, { cookie: cookie.split(";")[0]! }, true)).json()).toEqual(
		principal,
	);
	expect((await app.request(link.pathname, { token: link.hash.slice(1) })).status).toBe(403);
	expect(app.sessions.list.value).toContainEqual(
		expect.objectContaining({ principal, label: "Member browser", kind: "browser" }),
	);
	const expired = await invite();
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 7 * 24 * 60 * 60_000);
	try {
		expect((await app.request(expired.pathname, { token: expired.hash.slice(1) })).status).toBe(403);
	} finally {
		clock.mockRestore();
	}
	expect((await app.request(expired.pathname, { token: expired.hash.slice(1) })).status).toBe(403);
	expect(app.sessions.list.value).toHaveLength(2);
});
