import type { Context } from "../context/index.ts";
import type { Contract } from "../contracts/index.ts";
import { currentVariants, LOCAL, takesNoArgs } from "../contracts/internal.ts";
import { RegistryContribution, type Contributor, type RegistryRecord } from "../registries/internal.ts";
import { NativeSource, type Derive, type DeriveSource } from "../state/internal.ts";
import { resolveKeyed, resolveWatchable, type KeyedBinding } from "./reference.ts";
import { OwnEventSource, type EventNode, type SourceOwner } from "./events.ts";
import { ReexposedEvents, ReferenceEvents } from "./reference-events.ts";
export type { KeyedBinding } from "./reference.ts";
export type Members = {
	readonly methods: ReadonlyMap<string, (args: unknown, context: Context) => Promise<unknown>>;
	readonly state: ReadonlyMap<string, DeriveSource>;
	readonly keyed: ReadonlyMap<string, KeyedBinding>;
	readonly events: ReadonlyMap<string, EventNode>;
};
const noEvents: ReadonlyMap<string, EventNode> = new Map();

export function checkImplementation(
	contract: Contract,
	implementation: unknown,
	owner?: SourceOwner,
): { readonly variant: string | undefined; readonly members: Members } {
	let variant: string | undefined,
		value = implementation;
	if (contract.kind === "remote") {
		const remote = implementation as {
			readonly variant: string;
			readonly members: unknown;
		};
		variant = remote.variant;
		value = remote.members;
	}
	const shape = currentVariants(contract).get(variant ?? LOCAL);
	if (!shape) throw new Error(`variant ${JSON.stringify(variant)}: not a variant of ${contract.name}`);
	const methods = new Map<string, (args: unknown, context: Context) => Promise<unknown>>(),
		state = new Map<string, DeriveSource>(),
		keyed = new Map<string, KeyedBinding>();
	const object = value as Record<string, unknown>;
	for (const name of Object.keys(object))
		if (!shape.methods.has(name) && !shape.state.has(name) && !shape.keyed.has(name) && !shape.events.has(name))
			throw new Error(`${name}: not a member`);
	const own = (name: string): unknown => (Object.hasOwn(object, name) ? object[name] : undefined);
	for (const [name, method] of shape.methods) {
		const fn = own(name);
		if (typeof fn !== "function") throw new Error(`${name}: a method is a function`);
		methods.set(name, takesNoArgs(method) ? (_args, context) => fn(context) : (args, context) => fn(args, context));
	}
	for (const name of shape.state.keys()) {
		const source = resolveWatchable(own(name));
		if (!source) throw new Error(`${name}: a state member is a JSON watchable`);
		state.set(name, source);
	}
	for (const [name, { key }] of shape.keyed) {
		const member = resolveKeyed(own(name));
		if (!member) throw new Error(`${name}: a keyed member is a keyed document handle`);
		const actual = member.kind === "own" ? member.slot.definition.current.host?.kind : member.key;
		if (actual !== key?.kind) {
			const keys = (kind: string | undefined) => (kind === undefined ? "string keys" : `addresses of ${kind}`);
			throw new Error(`${name}: declared with ${keys(key?.kind)}, implemented with ${keys(actual)}`);
		}
		keyed.set(name, member);
	}
	let events = noEvents;
	if (shape.events.size) {
		const nodes = new Map<string, EventNode>();
		for (const name of shape.events.keys()) {
			const value = own(name);
			if (value instanceof OwnEventSource && owner && value.ownedBy(owner)) nodes.set(name, value);
			else if (value instanceof ReferenceEvents) nodes.set(name, new ReexposedEvents(value));
			else throw new Error(`${name}: an event member is this object's own self.events() or a reference's event member`);
		}
		events = nodes;
	}
	return { variant, members: { methods, state, keyed, events } };
}
export function attachDerives(
	derives: readonly Derive[],
	state: ReadonlyMap<string, DeriveSource>,
	report: (member: string | undefined) => (error: unknown) => void,
): void {
	const names = new Map([...state].map(([name, source]) => [source, name]));
	for (const [index, derive] of derives.entries()) {
		const member = names.get(derive),
			label = member ?? `derive #${index + 1}`;
		derive.attach((value, position) => {
			const source = resolveWatchable(value) ?? (value instanceof NativeSource ? value : undefined);
			if (!source) throw new Error(`${label}: source ${position} is not a Objects watchable`);
			return source;
		}, report(member));
	}
}
export function contributionOf(
	record: RegistryRecord,
	contributor: Contributor,
	version: number,
	value: unknown,
): RegistryContribution {
	const source = value instanceof NativeSource ? value : resolveWatchable(value);
	const content =
		source instanceof NativeSource
			? ({ kind: "native", source } as const)
			: source
				? ({ kind: "json", source } as const)
				: ({ kind: "plain", value } as const);
	return new RegistryContribution(record, contributor, version, content);
}
