import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveHttpProxyUrlForTarget } from "../src/utils/node-http-proxy.ts";

beforeEach(() => {
	for (const name of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"])
		for (const key of [name, name.toUpperCase()]) vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());

test("proxy settings prefer request values and lower-case names, then fall back to the ambient environment", () => {
	vi.stubEnv("https_proxy", "http://ambient.example:8080");
	const resolve = (env: Record<string, string>) => resolveHttpProxyUrlForTarget("https://api.example/v1", env)?.href;
	expect(resolve({})).toBe("http://ambient.example:8080/");
	expect(resolve({ HTTPS_PROXY: "http://upper.example:8081" })).toBe("http://upper.example:8081/");
	expect(resolve({ https_proxy: "http://lower.example:8082", HTTPS_PROXY: "http://upper.example:8081" })).toBe(
		"http://lower.example:8082/",
	);
	expect(resolve({ https_proxy: "", HTTPS_PROXY: "http://upper.example:8081" })).toBe("http://upper.example:8081/");
	vi.stubEnv("https_proxy", "");
	expect(resolve({ all_proxy: "http://all.example:8083" })).toBe("http://all.example:8083/");
	expect(resolve({ https_proxy: "proxy.example:3128" })).toBe("https://proxy.example:3128/");
});

test("host exclusions honor domains, ports, IPv6 and token separators", () => {
	const proxy = "http://proxy.example:3128";
	for (const [target, noProxy, bypass] of [
		["https://api.example.test", "example.test", true],
		["https://api.example.test", "*.example.test", true],
		["https://api.example.test", ".example.test", true],
		["https://api.example.test", "*example.test", true],
		["https://otherexample.test", "example.test", false],
		["https://api.example.test", "api.example.test:443", true],
		["https://api.example.test:8443", "api.example.test:443", false],
		["https://api.example.test:8443", "api.example.test:8443", true],
		["https://[::1]", "[::1]:443", true],
		["http://[::1]:9000", "::1", true],
		["http://[::1]:9000", "[::1]:8000", false],
		["https://API.EXAMPLE.TEST", " , other.test\tAPI.EXAMPLE.TEST, ", true],
		["https://api.example.test", "api.example.test:invalid", false],
	] as const) {
		const result = resolveHttpProxyUrlForTarget(new URL(target), { all_proxy: proxy, no_proxy: noProxy });
		expect(result?.href, `${target} with ${noProxy}`).toBe(bypass ? undefined : `${proxy}/`);
	}
});

test("only HTTP proxies are accepted and an excluded destination never uses an invalid proxy", () => {
	for (const proxy of ["socks5://proxy.example:1080", "pac://proxy.example/file"])
		expect(() => resolveHttpProxyUrlForTarget("https://api.example", { https_proxy: proxy })).toThrow(
			"Unsupported proxy protocol",
		);
	expect(() => resolveHttpProxyUrlForTarget("https://api.example", { https_proxy: "http://[" })).toThrow(
		"Invalid proxy URL",
	);
	expect(
		resolveHttpProxyUrlForTarget("https://api.example", { https_proxy: "http://[", no_proxy: "*" }),
	).toBeUndefined();
	for (const target of ["not a URL", "mailto:user@example.test"])
		expect(resolveHttpProxyUrlForTarget(target, { all_proxy: "http://proxy.example" })).toBeUndefined();
	expect(resolveHttpProxyUrlForTarget("https://api.example")).toBeUndefined();
});
