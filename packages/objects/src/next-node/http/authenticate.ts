import type { Context } from "../../context/index.ts";
import type { Principal } from "../../next/data/index.ts";
import { defineRegistry, type RegistryTable } from "../../next/registries/index.ts";
import type { HttpRequest } from "./request.ts";

export type Authenticator = (
	request: HttpRequest,
	context: Context,
) => Principal | undefined | Promise<Principal | undefined>;
export type AuthenticatorEntry = { readonly plugin: string; readonly authenticate: Authenticator };
export const Authenticators = defineRegistry<Authenticator, readonly AuthenticatorEntry[]>(
	"objects.http.authenticators",
	{ version: 1 },
);
export function composeAuthenticators(table: RegistryTable<Authenticator>): readonly AuthenticatorEntry[] {
	return table.map((entry) => ({ plugin: entry.plugin, authenticate: entry.value }));
}
export async function authenticate(
	entries: readonly AuthenticatorEntry[],
	request: HttpRequest,
	failed: (plugin: string, error: unknown) => void,
	context: Context,
): Promise<Principal | undefined> {
	for (const entry of entries) {
		if (context.abortSignal?.aborted) break;
		try {
			const authenticate = entry.authenticate;
			const principal = await authenticate(request, context);
			if (principal !== undefined) return principal;
		} catch (error) {
			failed(entry.plugin, error);
		}
	}
	return undefined;
}
