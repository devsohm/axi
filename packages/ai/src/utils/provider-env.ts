import type { ProviderEnv } from "../types.ts";
export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
	return env?.[name] || (typeof process === "undefined" ? undefined : process.env[name]) || undefined;
}
