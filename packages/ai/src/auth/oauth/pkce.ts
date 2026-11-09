function encode(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: encode(new Uint8Array(hash)) };
}
