import type { TUnsafe } from "typebox";
import { arr, local, map, method, nul, obj, str, union, type Static, type TSchema } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { invalid } from "../../data/internal.ts";
import { defineState } from "../../documents/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
function usersContract<T>(schema: TSchema) {
	const profile = schema as TUnsafe<T>;
	return local("objects.app.users", {
		version: 1,
		params: {},
		members: {
			list: arr(obj({ id: str(), profile })),
			get: method(str(), union([profile, nul()])),
			update: method(obj({ id: str(), profile })),
			remove: method(str()),
		},
	});
}
type UsersPlugin<T, P extends Principal> = {
	readonly Users: ReturnType<typeof usersContract<T>>;
	readonly facet: Facet<P>;
};
export function defineUsers<S extends TSchema, P extends Principal = Principal>(profile: S): UsersPlugin<Static<S>, P>;
export function defineUsers<T extends JsonValue, P extends Principal = Principal>(profile: TSchema): UsersPlugin<T, P>;
export function defineUsers<P extends Principal>(schema: TSchema): UsersPlugin<JsonValue, P> {
	const Users = usersContract<JsonValue>(schema),
		profile = schema as TUnsafe<JsonValue>;
	const Accounts = defineState("objects.app.users", {
		version: 1,
		schema: obj({ users: map(profile) }),
		persist: true,
		initial: () => ({ users: {} }),
		checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
	});
	const facet = defineFacet<P>((host) =>
		host.serve(Users, (_params, self) => {
			const state = self.state(Accounts);
			return {
				list: self.derive([state], ([value]) => Object.entries(value.users).map(([id, profile]) => ({ id, profile }))),
				get: async (id) => (Object.hasOwn(state.value.users, id) ? state.value.users[id]! : null),
				update: async ({ id, profile }, context) => {
					if (id === "__proto__") throw invalid("args", "users: __proto__ is no user id");
					await state.change((draft) => {
						draft.users[id] = profile;
					}, context);
					return null;
				},
				remove: async (id, context) => {
					await state.change((draft) => {
						delete draft.users[id];
					}, context);
					return null;
				},
			};
		}),
	);
	return { Users, facet };
}
