import { nul, obj, str, union } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Facet } from "../host/index.ts";
import { preferenceContract, preferenceFacet } from "./preference.ts";
const id = union([str({ max: 128 }), nul()]);
const pick = obj({ dark: id, light: id });
export const ThemeChoice = preferenceContract("objects.themes.choice", pick);
export function themeChoiceFacet<P extends Principal>(): Facet<P> {
	return preferenceFacet<P>(ThemeChoice, "objects.themes.picks", pick, { dark: null, light: null });
}
