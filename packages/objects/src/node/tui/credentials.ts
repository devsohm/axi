import { readFile } from "node:fs/promises";
import { writeSecret } from "../app/secrets.ts";
export type TerminalCredentials =
	| { readonly kind: "token"; readonly token: string }
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "pairing"; readonly label: string; readonly save?: string };
export async function tokenOf(
	credentials: TerminalCredentials,
	url: URL,
	say: (line: string) => void,
	signal: AbortSignal,
): Promise<string> {
	if (credentials.kind === "token") return credentials.token;
	if (credentials.kind === "file") return (await readFile(credentials.path, "utf8")).trim();
	const post = (path: string, value: unknown) =>
		fetch(new URL(path, url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(value),
			signal,
		});
	const response = await post("/_objects/pair", { label: credentials.label });
	if (!response.ok) throw new Error(`terminal: the server refused to pair (${response.status})`);
	const { code, poll } = (await response.json()) as { code?: unknown; poll?: unknown };
	if (typeof code !== "string" || !/^[A-Za-z0-9-]{4,32}$/.test(code) || typeof poll !== "string")
		throw new Error("terminal: the server's pairing answer is malformed");
	say(`Pairing code ${code}: approve it at ${new URL(`/_objects/pair/${code}`, url)} (signed in as the owner).`);
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		signal.throwIfAborted();
		const next = await post("/_objects/pair/poll", { poll });
		if (!next.ok) throw new Error("terminal: the pairing ended without approval");
		const answer = (await next.json()) as { status: string; token?: string };
		if (answer.status !== "approved" || answer.token === undefined) continue;
		if (credentials.save !== undefined) await writeSecret(credentials.save, answer.token, "create");
		return answer.token;
	}
}
