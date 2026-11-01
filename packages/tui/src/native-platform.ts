import { createRequire } from "node:module";
import { join } from "node:path";
import { getNativeModuleCandidates } from "./native-module-path.ts";
export type ModifierKey = "shift" | "command" | "control" | "option";
export interface NativeClipboard {
	getText(): Promise<string | null | undefined>;
	getImage(): Promise<Uint8Array | null | undefined>;
	getFilePaths?(): Promise<string[] | null | undefined>;
	setText?(text: string): Promise<void>;
}
type Helper = NativeClipboard & {
	enableVirtualTerminalInput?: () => boolean;
	isModifierPressed?: (name: ModifierKey) => boolean;
};
const require = createRequire(import.meta.url),
	loaded = new Map<string, Helper | undefined>();
function load(platform: string, suffix = ""): Helper | undefined {
	if (process.arch !== "x64" && process.arch !== "arm64") return;
	const path = join(
		"native",
		platform,
		"prebuilds",
		`${platform}-${process.arch}`,
		`${platform}-platform${suffix}.node`,
	);
	if (loaded.has(path)) return loaded.get(path);
	for (const candidate of getNativeModuleCandidates(path))
		try {
			const helper: unknown = require(candidate);
			if (
				typeof helper === "object" &&
				helper !== null &&
				"getText" in helper &&
				typeof helper.getText === "function" &&
				"getImage" in helper &&
				typeof helper.getImage === "function"
			) {
				const valid = helper as Helper;
				loaded.set(path, valid);
				return valid;
			}
		} catch {}
	loaded.set(path, undefined);
	return;
}
export function getNativePlatformHelper(): Helper | undefined {
	return process.platform === "darwin" || process.platform === "win32" ? load(process.platform) : undefined;
}
export function getNativeClipboard(): NativeClipboard | undefined {
	return process.platform !== "linux"
		? getNativePlatformHelper()
		: process.env.DISPLAY
			? load("linux", "-x11")
			: undefined;
}
