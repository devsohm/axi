import type { AuthContext } from "./types.ts";
export function defaultProviderAuthContext(): AuthContext {
	return {
		async env(name) {
			const value = globalThis.process?.env?.[name];
			return typeof value === "string" && value.trim() ? value : undefined;
		},
		async fileExists(path) {
			try {
				const filesystem = "node:fs/promises",
					operatingSystem = "node:os";
				const { access }: typeof import("node:fs/promises") = await import(filesystem);
				let resolved = path;
				if (path.startsWith("~")) {
					const os: typeof import("node:os") = await import(operatingSystem);
					resolved = os.homedir() + path.slice(1);
				}
				await access(resolved);
				return true;
			} catch {
				return false;
			}
		},
	};
}
