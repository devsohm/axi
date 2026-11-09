import { arr, hostKind, obj, opt, remote, str, type Static } from "../contracts/index.ts";
const entry = obj({ name: str(), digest: str(), url: str(), css: opt(str()) });
export type ScriptEntry = Static<typeof entry>;
export const ScriptSet = obj({ base: str(), combined: str(), plugins: arr(entry) });
export type ScriptSet = Static<typeof ScriptSet>;
function scripts<const N extends string>(name: N) {
	return remote(name, {
		version: 1,
		params: {},
		hostAddress: () => hostKind("server")(),
		variants: { main: { state: { set: ScriptSet } } },
	});
}
export const WebScripts = scripts("objects.web.scripts"),
	TuiScripts = scripts("objects.tui.scripts");
export type ScriptsContract = typeof WebScripts | typeof TuiScripts;
