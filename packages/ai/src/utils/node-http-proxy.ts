import type { ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "./provider-env.ts";
export const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
	"Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";
function setting(name: string, env?: ProviderEnv): string {
	return (
		env?.[name.toLowerCase()] ||
		env?.[name.toUpperCase()] ||
		getProviderEnvValue(name.toLowerCase()) ||
		getProviderEnvValue(name.toUpperCase()) ||
		""
	);
}
const unbracket = (host: string) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host);
function exclusion(entry: string): { host: string; port: number } {
	const text = entry.trim().toLowerCase();
	if (text.startsWith("[")) {
		const end = text.indexOf("]");
		if (end !== -1)
			return {
				host: text.slice(1, end),
				port: text[end + 1] === ":" ? Number.parseInt(text.slice(end + 2), 10) || 0 : 0,
			};
	}
	if (text.indexOf(":") === text.lastIndexOf(":") && text.includes(":")) {
		const at = text.lastIndexOf(":"),
			port = Number.parseInt(text.slice(at + 1), 10);
		if (!Number.isNaN(port)) return { host: text.slice(0, at), port };
	}
	return { host: text, port: 0 };
}
export function resolveHttpProxyUrlForTarget(targetUrl: string | URL, env?: ProviderEnv): URL | undefined {
	let target: URL;
	try {
		target = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
	} catch {
		return undefined;
	}
	if (!target.protocol || !target.host) return undefined;
	const protocol = target.protocol.slice(0, -1);
	const defaults: Record<string, number> = { ftp: 21, gopher: 70, http: 80, https: 443, ws: 80, wss: 443 };
	const port = Number.parseInt(target.port, 10) || defaults[protocol] || 0,
		host = unbracket(target.hostname.toLowerCase());
	const noProxy = setting("no_proxy", env).toLowerCase();
	if (
		noProxy === "*" ||
		noProxy.split(/[,\s]/).some((entry) => {
			const rule = exclusion(entry);
			if (rule.port && rule.port !== port) return false;
			const domain = unbracket(rule.host).replace(/^(?:\*\.|\.|\*)/, "");
			return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));
		})
	)
		return undefined;
	let proxy = setting(`${protocol}_proxy`, env) || setting("all_proxy", env);
	if (!proxy) return undefined;
	if (!proxy.includes("://")) proxy = `${protocol}://${proxy}`;
	let result: URL;
	try {
		result = new URL(proxy);
	} catch (error) {
		throw new Error(
			`Invalid proxy URL ${JSON.stringify(proxy)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (result.protocol !== "http:" && result.protocol !== "https:")
		throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${result.protocol}`);
	return result;
}
