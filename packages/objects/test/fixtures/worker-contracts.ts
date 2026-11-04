import { hostKind, method, remote, str } from "../../src/index.ts";
export const Runner = hostKind("runner", { id: str() });
export const Control = remote("runtime.control", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Runner({ id }),
	variants: { active: { state: { label: str() }, methods: { echo: method(str(), str()), crash: method(), loseLink: method() } } },
});
export const Value = remote("runtime.value", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Runner({ id }),
	variants: { active: { state: { text: str() }, methods: {} } },
});
