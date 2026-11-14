import { createHmac, timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "./request.ts";

export type CookieOptions = {
	readonly secret: string;
	readonly request: Pick<HttpRequest, "provenance">;
	readonly sameSite?: "Strict" | "Lax";
	readonly maxAge?: number;
};
const sign = (name: string, value: string, secret: string): string =>
	createHmac("sha256", secret).update(`${name}=${value}`).digest("base64url");
export function cookie(name: string, value: string, options: CookieOptions): string {
	const expiry = options.maxAge === undefined ? "" : Math.floor(Date.now() / 1000 + options.maxAge);
	const payload = `${encodeURIComponent(value)}.${expiry}`;
	return [
		`${name}=${payload}.${sign(name, payload, options.secret)}`,
		"HttpOnly",
		"Path=/",
		`SameSite=${options.sameSite ?? "Strict"}`,
		...(options.request.provenance.kind === "local" ? [] : ["Secure"]),
		...(options.maxAge === undefined ? [] : [`Max-Age=${Math.floor(options.maxAge)}`]),
	].join("; ");
}
export function readCookie(request: HttpRequest, name: string, secret: string): string | undefined {
	return readSignedCookie(request, name, secret)?.value;
}
export function readSignedCookie(
	request: HttpRequest,
	name: string,
	secret: string,
): { readonly value: string; readonly expires: number | undefined } | undefined {
	for (const field of (request.headers.get("cookie") ?? "").split(";")) {
		const equals = field.indexOf("=");
		if (equals < 0 || field.slice(0, equals).trim() !== name) continue;
		const raw = field.slice(equals + 1).trim();
		const signatureAt = raw.lastIndexOf("."),
			payload = raw.slice(0, signatureAt),
			expiryAt = payload.lastIndexOf(".");
		if (signatureAt < 0 || expiryAt < 0) return undefined;
		const expected = Buffer.from(sign(name, payload, secret)),
			received = Buffer.from(raw.slice(signatureAt + 1));
		if (expected.length !== received.length || !timingSafeEqual(expected, received)) return undefined;
		const stamp = payload.slice(expiryAt + 1);
		const expires = stamp === "" ? undefined : Number(stamp) * 1000;
		if (expires !== undefined && expires <= Date.now()) return undefined;
		try {
			return { value: decodeURIComponent(payload.slice(0, expiryAt)), expires };
		} catch {
			return undefined;
		}
	}
	return undefined;
}
