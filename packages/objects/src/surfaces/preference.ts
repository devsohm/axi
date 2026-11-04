import { BACKGROUND_CONTEXT } from "../context/index.ts";
import { hostKind, local, map, method, obj, remote, str, type Static, type TSchema } from "../contracts/index.ts";
import type { TUnsafe } from "typebox";
import type { JsonValue } from "../json.ts";
import type { Principal } from "../data/index.ts";
import { principalKey } from "../data/principal.ts";
import { defineState } from "../documents/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";

export function preferenceContract<const N extends string, S extends TSchema>(name: N, schema: S) {
	// Preserve the schema's static type without adding a runtime TypeBox marker.
	const pick = schema as unknown as TUnsafe<Static<S>>;
	return remote(name, {
		version: 1,
		params: {},
		hostAddress: () => hostKind("server")(),
		variants: { main: { state: { pick }, methods: { choose: method(pick) } } },
	});
}
export type PreferenceContract = ReturnType<typeof preferenceContract<string, TUnsafe<JsonValue>>>;
export function preferenceFacet<P extends Principal>(
	Choice: PreferenceContract,
	store: string,
	schema: TSchema,
	none: JsonValue,
): Facet<P> {
	const pick = schema as TUnsafe<JsonValue>;
	const Picks = defineState(store, {
		version: 1,
		schema: obj({ picks: map(pick) }),
		initial: () => ({ picks: {} }),
		persist: true,
		checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
	});
	const Store = local(store, {
		version: 1,
		params: {},
		members: { picks: map(pick), set: method(obj({ key: str(), pick })) },
	});
	return defineFacet<P>((host) => {
		host.serve(Store, (_params, self) => {
			const state = self.state(Picks);
			return {
				picks: self.derive([state], ([value]) => value.picks),
				set: async (update, context) => {
					await state.change((draft) => {
						delete draft.picks[update.key];
						draft.picks[update.key] = update.pick;
						const names = Object.keys(draft.picks);
						for (let index = 0; index < names.length - 10_000; index++) delete draft.picks[names[index]!];
					}, context);
					return null;
				},
			};
		});
		host.serve(Choice, (_params, principal, self) => {
			const stored = self.get(Store, {}),
				key = principalKey(principal, BACKGROUND_CONTEXT);
			return {
				variant: "main",
				members: {
					pick: self.derive([stored.picks], ([values]) => (Object.hasOwn(values, key) ? values[key]! : none)),
					choose: (value, context) => stored.set({ key, pick: value }, context),
				},
			};
		});
	});
}
