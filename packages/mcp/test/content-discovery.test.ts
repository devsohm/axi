import { expect, test } from "vitest";
import { toLlmContent } from "../src/index.ts";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
	parseWwwAuthenticate,
	selectResource,
} from "../src/oauth/discovery.ts";

test("tool content converts each supported block without forwarding private metadata", () => {
	expect(
		toLlmContent({
			content: [
				{ type: "text", text: "ready", _meta: { private: true } },
				{ type: "image", data: "AA==", mimeType: "image/webp", annotations: { priority: 1 } },
				{ type: "audio", data: "AQ==", mimeType: "audio/ogg" },
				{ type: "resource_link", name: "guide", uri: "file:///guide" },
				{ type: "resource", resource: { uri: "file:///text", text: "inline document" } },
				{ type: "resource", resource: { uri: "file:///image", mimeType: "image/jpeg", blob: "Ag==" } },
				{ type: "resource", resource: { uri: "file:///archive", mimeType: "application/zip", blob: "Aw==" } },
				{ type: "resource", resource: { uri: "file:///opaque", blob: "BA==" } },
			],
		}),
	).toEqual([
		{ type: "text", text: "ready" },
		{ type: "image", data: "AA==", mimeType: "image/webp" },
		{ type: "text", text: "[audio audio/ogg omitted]" },
		{ type: "text", text: "guide: file:///guide" },
		{ type: "text", text: "inline document" },
		{ type: "image", data: "Ag==", mimeType: "image/jpeg" },
		{ type: "text", text: "[binary resource file:///archive (application/zip) omitted]" },
		{ type: "text", text: "[binary resource file:///opaque (unknown type) omitted]" },
	]);
});

test("structured results become JSON only when a tool returned no content blocks", () => {
	for (const [value, expected] of [
		[null, "null"],
		[false, "false"],
		[5, "5"],
		["ready", '"ready"'],
		[[3], "[\n  3\n]"],
		[{ ok: true }, '{\n  "ok": true\n}'],
	] as const)
		expect(toLlmContent({ content: [], structuredContent: value })).toEqual([{ type: "text", text: expected }]);
	expect(toLlmContent({ content: [{ type: "text", text: "rendered" }], structuredContent: { hidden: true } })).toEqual([
		{ type: "text", text: "rendered" },
	]);
	expect(toLlmContent({ content: [] })).toEqual([]);
});

test("authorization challenges parse quoted and bare fields without accepting unrelated schemes", () => {
	expect(
		parseWwwAuthenticate(
			'Bearer resource_metadata="https://auth.example.test/resource", scope="read write", error=insufficient_scope, error_description="more access"',
		),
	).toEqual({
		resourceMetadataUrl: new URL("https://auth.example.test/resource"),
		scope: "read write",
		error: "insufficient_scope",
		errorDescription: "more access",
	});
	expect(parseWwwAuthenticate("DPoP scope=read").scope).toBe("read");
	for (const challenge of [null, "", 'Basic realm="private"']) expect(parseWwwAuthenticate(challenge)).toEqual({});
	expect(parseWwwAuthenticate("Bearer resource_metadata=not-a-url").resourceMetadataUrl).toBeUndefined();
});

test("resource discovery falls back by path only when the endpoint is absent", async () => {
	const urls: string[] = [];
	const metadata = await discoverProtectedResourceMetadata("https://tools.example.test/team/mcp/", {
		fetch: async (input) => {
			urls.push(String(input));
			return urls.length === 1
				? new Response(null, { status: 404 })
				: Response.json({
						resource: "https://tools.example.test/team",
						authorization_servers: ["https://login.example.test"],
					});
		},
	});
	expect(urls).toEqual([
		"https://tools.example.test/.well-known/oauth-protected-resource/team/mcp",
		"https://tools.example.test/.well-known/oauth-protected-resource",
	]);
	expect(selectResource("https://tools.example.test/team/mcp#ignored", metadata)).toBe(
		"https://tools.example.test/team",
	);
	for (const server of ["https://tools.example.test/teammate", "https://other.example.test/team"])
		expect(() => selectResource(server, metadata)).toThrow("does not match MCP server");
	const failed: string[] = [];
	await expect(
		discoverProtectedResourceMetadata("https://tools.example.test/mcp", {
			fetch: async (input) => {
				failed.push(String(input));
				return new Response(null, { status: 503 });
			},
		}),
	).rejects.toThrow("HTTP 503");
	expect(failed).toEqual(["https://tools.example.test/.well-known/oauth-protected-resource/mcp"]);
});

test("issuer discovery follows endpoint order, rejects substitutions and preserves explicit overrides", async () => {
	const issuer = "https://login.example.test/tenant";
	const reply = {
		issuer,
		authorization_endpoint: issuer + "/authorize",
		token_endpoint: issuer + "/token",
		response_types_supported: ["code"],
	};
	const visited: string[] = [];
	expect(
		await discoverAuthorizationServerMetadata(issuer, {
			fetch: async (input) => {
				visited.push(String(input));
				return visited.length < 3 ? new Response(null, { status: 404 }) : Response.json(reply);
			},
		}),
	).toEqual(reply);
	expect(visited).toEqual([
		"https://login.example.test/.well-known/oauth-authorization-server/tenant",
		"https://login.example.test/.well-known/openid-configuration/tenant",
		"https://login.example.test/tenant/.well-known/openid-configuration",
	]);
	await expect(
		discoverAuthorizationServerMetadata("https://wrong.example.test", { fetch: async () => Response.json(reply) }),
	).rejects.toMatchObject({
		name: "OAuthIssuerMismatchError",
		expected: "https://wrong.example.test",
		received: issuer,
	});
	expect(
		await discoverAuthorizationServerMetadata(issuer, { fetch: async () => new Response(null, { status: 404 }) }),
	).toBeUndefined();
	expect(
		await discoverOAuthServerInfo("https://tools.example.test/mcp", {
			authorizationServerMetadataUrl: new URL("https://login.example.test/custom"),
			fetch: async (input) =>
				String(input).endsWith("/custom") ? Response.json(reply) : new Response(null, { status: 404 }),
		}),
	).toEqual({ authorizationServerUrl: issuer, authorizationServerMetadata: reply, resourceMetadata: undefined });
});
