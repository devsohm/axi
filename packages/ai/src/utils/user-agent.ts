const os = typeof process !== "undefined" && process.versions?.node ? process.getBuiltinModule?.("node:os") : undefined;
export function getUserAgent(): string {
	return os ? `axi (${os.platform()} ${os.release()}; ${os.arch()})` : "axi (browser)";
}
