import { nul, str, union } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Facet } from "../host/index.ts";
import { preferenceContract, preferenceFacet } from "./preference.ts";
const pick = union([str({ max: 35, pattern: "^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$" }), nul()]);
export const LocaleChoice = preferenceContract("objects.locale.choice", pick);
export function localeChoiceFacet<P extends Principal>(): Facet<P> {
	return preferenceFacet<P>(LocaleChoice, "objects.locale.picks", pick, null);
}
