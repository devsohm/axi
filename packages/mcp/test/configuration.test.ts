import { expect, test } from "vitest";
import { isMcpServerOverride, validateMcpServerConfig } from "../src/index.ts";

test("server configuration rejects invalid transports and preserves valid transport-specific settings", () => {
	for (const [raw, field] of [
		[null, "object"],
		[[], "object"],
		[true, "object"],
		[{ enabled: 1 }, "enabled"],
		[{ description: 3 }, "description"],
		[{ timeout: 0 }, "timeout"],
		[{ timeout: -1 }, "timeout"],
		[{ timeout: "10" }, "timeout"],
		[{ timeout: NaN }, "timeout"],
		[{ type: "sse", url: "https://server.invalid" }, "legacy SSE"],
		[{ url: "bad" }, "url"],
		[{ url: "file:///server" }, "url"],
		[{ url: "https://server.invalid", headers: { Authorization: 1 } }, "headers"],
		[{ command: "server", args: "one" }, "args"],
		[{ command: "server", args: [1] }, "args"],
		[{ command: "server", env: [] }, "env"],
		[{ command: "server", env: { PORT: 8000 } }, "env"],
		[{ command: "server", cwd: 1 }, "cwd"],
		[{ type: "other" }, "command"],
	] satisfies [unknown, string][]) {
		const result = validateMcpServerConfig("sample", raw);
		expect(result).toMatchObject({ kind: "invalid", error: expect.stringContaining(field) });
	}
	expect(validateMcpServerConfig("bad name", {})).toMatchObject({
		kind: "invalid",
		error: expect.stringContaining("server name"),
	});
	const stdio = {
		type: "stdio",
		command: "server",
		args: ["--stdio"],
		cwd: "/project",
		env: { PORT: "8000" },
		enabled: false,
		timeout: 10,
		description: "Local",
		extra: true,
	};
	const local = validateMcpServerConfig("local_1", stdio);
	expect(local.kind).toBe("stdio");
	if (local.kind === "stdio") expect(local.config).toBe(stdio);
	for (const type of [undefined, "http", "streamable-http"]) {
		const config = { type, url: "http://localhost/mcp", headers: { Authorization: "Bearer fixture" } };
		const result = validateMcpServerConfig("remote-1", config);
		expect(result.kind).toBe("http");
		if (result.kind === "http") expect(result.config).toBe(config);
	}
	expect(isMcpServerOverride({ enabled: false, timeout: 10 })).toBe(true);
	for (const override of [{ command: "server" }, { url: "https://server.invalid" }, { type: "stdio" }])
		expect(isMcpServerOverride(override)).toBe(false);
});

test("OAuth configuration validates client fields, loopback callbacks and metadata endpoints", () => {
	const url = "https://server.invalid/mcp";
	for (const [oauth, field] of [
		[null, "oauth"],
		[[], "oauth"],
		[{ clientId: 1 }, "clientId"],
		[{ clientSecret: false }, "clientSecret"],
		[{ callbackPort: 0 }, "callbackPort"],
		[{ callbackPort: 65536 }, "callbackPort"],
		[{ callbackPort: 1.5 }, "callbackPort"],
		[{ callbackPort: "8000" }, "callbackPort"],
		[{ callbackUrl: 42 }, "callbackUrl"],
		[{ callbackUrl: "bad" }, "callbackUrl"],
		[{ callbackUrl: "https://localhost/callback" }, "callbackUrl"],
		[{ callbackUrl: "http://remote.invalid/callback" }, "callbackUrl"],
		[{ callbackUrl: "http://localhost/callback?code=1" }, "callbackUrl"],
		[{ callbackUrl: "http://localhost/callback#fragment" }, "callbackUrl"],
		[{ callbackUrl: "http://localhost:8000/callback", callbackPort: 8001 }, "different ports"],
		[{ scope: [] }, "scope"],
		[{ clientName: 1 }, "clientName"],
		[{ clientName: "  " }, "clientName"],
		[{ clientRegistration: "other" }, "clientRegistration"],
		[{ authServerMetadataUrl: "http://remote.invalid/metadata" }, "authServerMetadataUrl"],
		[{ authServerMetadataUrl: 1 }, "authServerMetadataUrl"],
	] satisfies [unknown, string][])
		expect(validateMcpServerConfig("remote", { url, oauth })).toMatchObject({
			kind: "invalid",
			error: expect.stringContaining(field),
		});
	for (const callbackUrl of ["http://localhost/callback", "http://127.0.0.1:8000/callback", "http://[::1]/callback"])
		expect(validateMcpServerConfig("remote", { url, oauth: { callbackUrl } }).kind).toBe("http");
	for (const authServerMetadataUrl of [
		"https://issuer.invalid/metadata",
		"http://localhost/metadata",
		"http://127.0.0.1/metadata",
		"http://[::1]/metadata",
	])
		expect(validateMcpServerConfig("remote", { url, oauth: { authServerMetadataUrl } }).kind).toBe("http");
	for (const clientRegistration of ["auto", "dcr"])
		expect(
			validateMcpServerConfig("remote", {
				url,
				oauth: {
					clientRegistration,
					clientId: "client",
					clientSecret: "secret",
					clientName: "Client",
					callbackPort: 65535,
					scope: "tools",
				},
			}).kind,
		).toBe("http");
});

test("metadata-document registration delegates callback checks and rejects conflicting registration settings", () => {
	const config = { url: "https://server.invalid/mcp", oauth: { clientRegistration: "cimd" } };
	expect(validateMcpServerConfig("remote", config)).toMatchObject({
		kind: "invalid",
		error: expect.stringContaining("not supported"),
	});
	for (const extra of [{ clientId: "client" }, { clientName: "Client" }])
		expect(validateMcpServerConfig("remote", { ...config, oauth: { ...config.oauth, ...extra } })).toMatchObject({
			kind: "invalid",
			error: expect.stringContaining("cannot be combined"),
		});
	const callbacks: (string | undefined)[] = [];
	const checkMetadataDocumentCallback = (value: string | undefined) => {
		callbacks.push(value);
		return value ? undefined : "callback required";
	};
	expect(validateMcpServerConfig("remote", config, { checkMetadataDocumentCallback })).toMatchObject({
		kind: "invalid",
		error: expect.stringContaining("callback required"),
	});
	const withCallback = { ...config, oauth: { ...config.oauth, callbackUrl: "http://localhost/callback" } };
	expect(validateMcpServerConfig("remote", withCallback, { checkMetadataDocumentCallback }).kind).toBe("http");
	expect(callbacks).toEqual([undefined, "http://localhost/callback"]);
});
