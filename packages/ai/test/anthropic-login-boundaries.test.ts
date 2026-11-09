import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
const old: OAuthCredential = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 };
function copyInteraction(input: (url: URL) => string): ProviderAuthInteraction {
	let authorization: URL | undefined;
	return {
		signal: new AbortController().signal,
		notify(event) {
			if (event.type === "auth_url") authorization = new URL(event.url);
		},
		async prompt(prompt) {
			if (prompt.type === "select") return "copy_code";
			if (!authorization) throw new Error("Authorization URL was not provided");
			return input(authorization);
		},
	};
}

test.each(["raw", "fragment", "query", "url"] as const)(
	"copy-code login accepts %s input and exchanges its PKCE verifier",
	async (format) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
		let authorization: URL | undefined;
		const request = vi.fn<typeof fetch>(async (input, init) => {
			expect(String(input)).toBe("https://platform.claude.com/v1/oauth/token");
			const body = JSON.parse(String(init?.body));
			expect(body).toMatchObject({
				grant_type: "authorization_code",
				code: "accepted-code",
				redirect_uri: "https://platform.claude.com/oauth/code/callback",
				state: authorization?.searchParams.get("state"),
			});
			expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(
				authorization?.searchParams.get("code_challenge"),
			);
			return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
		});
		vi.stubGlobal("fetch", request);
		const credential = await anthropicOAuth.login(
			copyInteraction((url) => {
				authorization = url;
				const state = url.searchParams.get("state");
				switch (format) {
					case "raw":
						return "  accepted-code  ";
					case "fragment":
						return `accepted-code#${state}`;
					case "query":
						return `code=accepted-code&state=${state}`;
					case "url":
						return `https://app.example/callback?code=accepted-code&state=${state}`;
				}
			}),
		);
		expect(credential).toEqual({
			type: "oauth",
			access: "new-access",
			refresh: "new-refresh",
			expires: Date.now() + 3300000,
		});
		expect(await anthropicOAuth.toAuth(credential)).toEqual({ apiKey: "new-access" });
		expect(request).toHaveBeenCalledTimes(1);
	},
);

test.each(["", "  ", "https://app.example/callback", "code=&state="])(
	"missing authorization input %j never reaches the token endpoint",
	async (input) => {
		const request = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", request);
		await expect(anthropicOAuth.login(copyInteraction(() => input))).rejects.toThrow("Missing authorization code");
		expect(request).not.toHaveBeenCalled();
	},
);

test("an unsupported login selection produces no authorization URL or network request", async () => {
	const request = vi.fn<typeof fetch>(),
		notify = vi.fn();
	vi.stubGlobal("fetch", request);
	await expect(
		anthropicOAuth.login({ signal: new AbortController().signal, prompt: async () => "unknown", notify }),
	).rejects.toThrow("Unknown Anthropic login method");
	expect(notify).not.toHaveBeenCalled();
	expect(request).not.toHaveBeenCalled();
});

test.each(["login", "refresh"] as const)(
	"%s reports malformed token JSON without manufacturing credentials",
	async (mode) => {
		vi.stubGlobal("fetch", async () => new Response("not-json"));
		const pending =
			mode === "login"
				? anthropicOAuth.login(copyInteraction(() => "accepted-code"))
				: anthropicOAuth.refresh(old, new AbortController().signal);
		await expect(pending).rejects.toThrow(
			mode === "login" ? "Token exchange returned invalid JSON" : "Anthropic token refresh returned invalid JSON",
		);
	},
);

test.each(["login", "refresh"] as const)("%s retains HTTP failure details in its diagnostic", async (mode) => {
	vi.stubGlobal("fetch", async () => new Response("access denied", { status: 403 }));
	const pending =
		mode === "login"
			? anthropicOAuth.login(copyInteraction(() => "accepted-code"))
			: anthropicOAuth.refresh(old, new AbortController().signal);
	await expect(pending).rejects.toThrow(/status=403.*body=access denied/);
});

test.each([
	"offline",
	Object.assign(new Error("offline", { cause: "disconnected" }), { code: "ECONNRESET", errno: 0 }),
	new Error(),
])("refresh preserves transport error details for %j", async (failure) => {
	vi.stubGlobal("fetch", async () => {
		throw failure;
	});
	let rejected: unknown;
	try {
		await anthropicOAuth.refresh(old, new AbortController().signal);
	} catch (error) {
		rejected = error;
	}
	expect(rejected).toBeInstanceOf(Error);
	if (!(rejected instanceof Error)) throw new Error("The refresh did not reject");
	expect(rejected.message).toContain("Anthropic token refresh request failed");
	if (typeof failure === "string") expect(rejected.message).toContain("details=offline");
	else if ("code" in failure) {
		expect(rejected.message).toContain("code=ECONNRESET");
		expect(rejected.message).toContain("errno=0");
		expect(rejected.message).toContain("cause=disconnected");
	}
});

test("browser login falls back from an occupied callback port and cancels its manual prompt after the callback", async () => {
	const blocker = createServer();
	await new Promise<void>((resolve, reject) => {
		blocker.once("error", (error) => {
			if ("code" in error && error.code === "EADDRINUSE") resolve();
			else reject(error);
		});
		blocker.listen(53692, "127.0.0.1", resolve);
	});
	let manualSignal: AbortSignal | undefined, callback: Promise<void> | undefined, redirect: URL | undefined;
	const tokenRequests: unknown[] = [];
	vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		if (String(input).startsWith("http://localhost:")) return realFetch(input, init);
		tokenRequests.push(JSON.parse(String(init?.body)));
		return Response.json({ access_token: "browser-access", refresh_token: "browser-refresh", expires_in: 3600 });
	});
	try {
		const credential = await anthropicOAuth.login({
			signal: new AbortController().signal,
			notify(event) {
				if (event.type !== "auth_url") return;
				const url = new URL(event.url);
				redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				const target = new URL(redirect);
				target.searchParams.set("code", "browser-code");
				target.searchParams.set("state", url.searchParams.get("state") ?? "");
				callback = realFetch(target).then(async (response) => {
					expect(response.status).toBe(200);
					await response.text();
				});
			},
			prompt(prompt) {
				if (prompt.type === "select") return Promise.resolve("browser");
				manualSignal = prompt.signal;
				return new Promise<string>((_resolve, reject) =>
					prompt.signal?.addEventListener("abort", () => reject(new Error("manual prompt cancelled")), { once: true }),
				);
			},
		});
		await callback;
		expect(credential.access).toBe("browser-access");
		expect(manualSignal?.aborted).toBe(true);
		expect(redirect?.port).not.toBe("53692");
		expect(tokenRequests).toEqual([
			expect.objectContaining({ grant_type: "authorization_code", code: "browser-code", redirect_uri: redirect?.href }),
		]);
	} finally {
		await callback;
		if (blocker.listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
	}
});

test.each([false, true])("browser manual input checks its state before exchange, mismatched=%s", async (mismatched) => {
	let authorization: URL | undefined;
	const request = vi.fn<typeof fetch>(async () =>
		Response.json({ access_token: "manual-access", refresh_token: "manual-refresh", expires_in: 3600 }),
	);
	vi.stubGlobal("fetch", request);
	const pending = anthropicOAuth.login({
		signal: new AbortController().signal,
		notify(event) {
			if (event.type === "auth_url") authorization = new URL(event.url);
		},
		async prompt(prompt) {
			if (prompt.type === "select") return "browser";
			return `manual-code#${mismatched ? "wrong-state" : authorization?.searchParams.get("state")}`;
		},
	});
	if (mismatched) {
		await expect(pending).rejects.toThrow("OAuth state mismatch");
		expect(request).not.toHaveBeenCalled();
	} else {
		expect((await pending).access).toBe("manual-access");
		expect(request).toHaveBeenCalledTimes(1);
	}
});

test("a cancelled browser login closes callback attempts and cannot obtain tokens", async () => {
	const controller = new AbortController();
	controller.abort(new Error("login cancelled"));
	const request = vi.fn<typeof fetch>(async (_input, init) => {
		expect(init?.signal?.aborted).toBe(true);
		init?.signal?.throwIfAborted();
		throw new Error("An aborted request cannot succeed");
	});
	vi.stubGlobal("fetch", request);
	await expect(
		anthropicOAuth.login({
			signal: controller.signal,
			notify() {},
			prompt: async (prompt) => (prompt.type === "select" ? "browser" : "unused-code"),
		}),
	).rejects.toThrow("login cancelled");
	expect(request).toHaveBeenCalledTimes(1);
});
