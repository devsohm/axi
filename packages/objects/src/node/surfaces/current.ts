import type { Context } from "../../context/index.ts";
import { local, method } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { ScriptSet, TuiScripts, WebScripts } from "../../surfaces/index.ts";
export type SurfaceName = "web" | "tui";
function current<const N extends string>(name: N) {
	return local(name, { version: 1, params: {}, members: { set: ScriptSet, publish: method(ScriptSet) } });
}
const currents = { web: current("objects.web.current"), tui: current("objects.tui.current") };
const scripts = { web: WebScripts, tui: TuiScripts };
export function scriptsFacet<P extends Principal>(
	surface: SurfaceName,
	published: { readonly set: ScriptSet },
): Facet<P> {
	return defineFacet<P>((host) => {
		host.serve(currents[surface], (_params, self) => {
			const state = self.writable(published.set);
			return {
				set: self.derive([state], ([value]) => value),
				publish: async (next) => {
					state.set(next);
					return null;
				},
			};
		});
		host.serve(scripts[surface], (_params, _principal, self) => {
			const current = self.get(currents[surface], {});
			return { variant: "main", members: { set: self.derive([current.set], ([value]) => value) } };
		});
	});
}
export async function publishTo<P extends Principal>(
	host: Host<P>,
	surface: SurfaceName,
	set: ScriptSet,
	context: Context,
): Promise<void> {
	const ref = await host.get(currents[surface], {}, context);
	try {
		await ref.publish(set, context);
	} finally {
		ref.release();
	}
}
