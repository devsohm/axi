import { getNativePlatformHelper, type ModifierKey } from "./native-platform.ts";
export type { ModifierKey } from "./native-platform.ts";
export function isNativeModifierPressed(key: ModifierKey): boolean {
	try {
		return getNativePlatformHelper()?.isModifierPressed?.(key) === true;
	} catch {
		return false;
	}
}
