import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
export function newToken(bytes = 32): string {
	return randomBytes(bytes).toString("base64url");
}
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}
export function matchesHash(token: string, hash: string): boolean {
	const left = Buffer.from(hashToken(token), "hex"),
		right = Buffer.from(hash, "hex");
	return left.length === right.length && timingSafeEqual(left, right);
}
export async function readSecret(path: string): Promise<string | undefined> {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch (error) {
		if (error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT") return undefined;
		throw error;
	}
}
export async function secretFile(path: string): Promise<string> {
	const previous = await readSecret(path);
	if (previous !== undefined) return previous;
	const value = newToken();
	return (await writeSecret(path, value, "create")) === "exists" ? ((await readSecret(path)) ?? value) : value;
}
export async function writeSecret(
	path: string,
	text: string,
	mode: "create" | "replace",
): Promise<"written" | "exists"> {
	const temporary = join(dirname(path), `.${newToken(9)}.tmp`),
		file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(text + "\n");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		if (mode === "replace") await rename(temporary, path);
		else await link(temporary, path);
		return "written";
	} catch (error) {
		if (error && typeof error === "object" && Reflect.get(error, "code") === "EEXIST") return "exists";
		throw error;
	} finally {
		await unlink(temporary).catch(() => {});
	}
}
