export function checkName(name: string, what: string): void {
	if (typeof name !== "string" || !/^[a-z0-9@/._~-]+$/.test(name))
		throw new Error(`${what} ${JSON.stringify(name)}: expected lowercase [a-z0-9@/._~-]`);
}
