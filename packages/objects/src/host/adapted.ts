import type { JsonValue } from "../json.ts";
import { currentVariants, LOCAL, variantsAt } from "../contracts/internal.ts";
import { ObjectsError } from "../data/index.ts";
import { Derive, type Batch, type DeriveSource } from "../state/internal.ts";
import type { ObjectsMetrics } from "../telemetry.ts";
import { EventNode, type EventEntry, type EventFlush, type Tap } from "./events.ts";
import type { Served } from "./object.ts";

type Mapper = ((value: never) => JsonValue) | "refuse";
type Versioned = Pick<Served, "kind" | "contract" | "provider">;
type Mappings = {
	readonly state?: Readonly<Record<string, Mapper | Readonly<Record<string, Mapper>>>>;
	readonly keyed?: Readonly<Record<string, Mapper>>;
	readonly events?: Readonly<Record<string, Mapper | Readonly<Record<string, Mapper>>>>;
};
export type AdaptedInstance = {
	readonly served: Versioned;
	readonly variant: string | undefined;
	readonly label: string;
	readonly batch: Batch;
	member(name: string): DeriveSource;
	event(name: string): EventNode | undefined;
	report(member: string, error: unknown): void;
	reportEvent(member: string, error: unknown): void;
	readonly metrics: ObjectsMetrics;
};

function mappings(served: Versioned, version: number): Mappings | undefined {
	return (served.provider.accepts as Readonly<Record<number, Mappings>>)[version];
}
function stateMapping(
	served: Versioned,
	version: number,
	variant: string | undefined,
	name: string,
): Mapper | undefined {
	const state = mappings(served, version)?.state;
	return served.kind === "local"
		? (state?.[name] as Mapper | undefined)
		: (state?.[variant ?? ""] as Readonly<Record<string, Mapper>> | undefined)?.[name];
}
function eventMapping(
	served: Versioned,
	version: number,
	variant: string | undefined,
	name: string,
): Mapper | undefined {
	const events = mappings(served, version)?.events;
	return served.kind === "local"
		? (events?.[name] as Mapper | undefined)
		: (events?.[variant ?? ""] as Readonly<Record<string, Mapper>> | undefined)?.[name];
}
function refused(served: Versioned, version: number, member?: string): ObjectsError {
	return new ObjectsError({
		code: "contract_mismatch",
		message:
			member === undefined
				? `${served.contract.name} v${version} is not served here`
				: `${served.contract.name} v${version}: member "${member}" is refused by its provider`,
	});
}
export function refusal(served: Served, version: number, variant: string | undefined): ObjectsError | undefined {
	if (!served.provider.accepted.some((item) => item.version === version)) return refused(served, version);
	const shape = variantsAt(served.contract, version).get(variant ?? LOCAL);
	for (const member of shape?.state.keys() ?? [])
		if (stateMapping(served, version, variant, member) === "refuse") return refused(served, version, member);
	for (const member of shape?.keyed.keys() ?? [])
		if (mappings(served, version)?.keyed?.[member] === "refuse") return refused(served, version, member);
	for (const member of shape?.events.keys() ?? [])
		if (eventMapping(served, version, variant, member) === "refuse") return refused(served, version, member);
	return undefined;
}

type MappedKey = { readonly source: Derive; users: number };
export class AdaptedMembers {
	readonly version: number;
	readonly #instance: AdaptedInstance;
	readonly #members = new Map<string, DeriveSource>();
	// Unchanged sources belong to the provider; only derived views belong to this version.
	readonly #derived = new Set<Derive>();
	readonly #keys = new Map<string, Map<DeriveSource, MappedKey>>();
	#events: Map<string, MappedEvents> | undefined;
	constructor(instance: AdaptedInstance, version: number) {
		this.#instance = instance;
		this.version = version;
	}
	member(name: string): DeriveSource {
		const cached = this.#members.get(name);
		if (cached !== undefined) return cached;
		this.#assertAccepted();
		const instance = this.#instance,
			mapping = stateMapping(instance.served, this.version, instance.variant, name);
		if (mapping === "refuse") throw refused(instance.served, this.version, name);
		let source: DeriveSource;
		if (mapping === undefined) source = instance.member(name);
		else {
			const shape = currentVariants(instance.served.contract).get(instance.variant ?? LOCAL)!;
			const kept = shape.state.has(name),
				names = kept ? [name] : [...shape.state.keys()];
			const inputs = names.map((member) => instance.member(member));
			const derive = new Derive(
				inputs,
				(values) =>
					this.#map(
						mapping,
						kept ? values[0] : Object.fromEntries(names.map((member, index) => [member, values[index]])),
					),
				instance.batch,
			);
			derive.attach(
				(value) => value as DeriveSource,
				(error) => instance.report(name, error),
			);
			this.#derived.add(derive);
			source = derive;
		}
		this.#members.set(name, source);
		return source;
	}
	keyed(name: string): ((value: JsonValue) => JsonValue) | undefined {
		this.#assertAccepted();
		const mapping = mappings(this.#instance.served, this.version)?.keyed?.[name];
		if (mapping === "refuse") throw refused(this.#instance.served, this.version, name);
		return mapping === undefined ? undefined : (value) => this.#map(mapping, value);
	}
	key(name: string, document: DeriveSource): { readonly source: DeriveSource; release(): void } {
		const mapping = this.keyed(name);
		if (mapping === undefined) return { source: document, release() {} };
		let keys = this.#keys.get(name);
		if (keys === undefined) this.#keys.set(name, (keys = new Map()));
		let entry = keys.get(document);
		if (entry === undefined) {
			const source = new Derive([document], ([value]) => mapping(value as JsonValue), this.#instance.batch);
			source.attach(
				(value) => value as DeriveSource,
				() => {},
			);
			keys.set(document, (entry = { source, users: 0 }));
		}
		entry.users++;
		const held = entry,
			table = keys;
		let open = true;
		return {
			source: held.source,
			release: () => {
				if (!open) return;
				open = false;
				if (--held.users !== 0 || table.get(document) !== held) return;
				table.delete(document);
				if (table.size === 0 && this.#keys.get(name) === table) this.#keys.delete(name);
				held.source.detach(this.#ended());
			},
		};
	}

	event(name: string): EventNode | undefined {
		const instance = this.#instance;
		if (!instance.served.provider.accepted.some((entry) => entry.version === this.version)) return;
		const source = instance.event(name);
		if (!source) return;
		const mapping = eventMapping(instance.served, this.version, instance.variant, name);
		if (mapping === undefined) return source;
		if (mapping === "refuse") return;
		const events = (this.#events ??= new Map());
		let mapped = events.get(name);
		if (!mapped) {
			mapped = new MappedEvents(source, mapping, instance.metrics, (error) => instance.reportEvent(name, error));
			events.set(name, mapped);
		}
		return mapped;
	}
	detach(error: Error): void {
		for (const node of this.#events?.values() ?? []) node.detach();
		this.#events = undefined;
		for (const source of this.#derived) source.detach(error);
		for (const table of this.#keys.values()) for (const { source } of table.values()) source.detach(error);
		this.#derived.clear();
		this.#members.clear();
		this.#keys.clear();
	}
	#map(mapping: Exclude<Mapper, string>, value: unknown): JsonValue {
		this.#instance.batch.count("objects.contract.adapts");
		return mapping(value as never);
	}
	#assertAccepted(): void {
		if (!this.#instance.served.provider.accepted.some((entry) => entry.version === this.version))
			throw refused(this.#instance.served, this.version);
	}
	#ended(): ObjectsError {
		return new ObjectsError({
			code: "released",
			reason: "ended",
			message: `${this.#instance.label}: ended`,
		});
	}
}

class MappedEvents extends EventNode {
	readonly #source: EventNode;
	readonly #tap: Tap;
	#failed = false;
	constructor(
		source: EventNode,
		mapping: Exclude<Mapper, string>,
		metrics: ObjectsMetrics,
		report: (error: unknown) => void,
	) {
		super();
		this.#source = source;
		this.#tap = {
			boundAt: -Infinity,
			deliver: (entry: EventEntry, flush: EventFlush) => {
				if (!this.tapped) return;
				let value: JsonValue;
				try {
					value = mapping(entry.value as never);
				} catch (error) {
					metrics.counter("objects.events.dropped").add(1, { reason: "mapping" });
					if (!this.#failed) report(error);
					this.#failed = true;
					return;
				}
				this.#failed = false;
				this.deliver({ node: this, value, at: entry.at, n: entry.n, part: undefined }, flush);
			},
		};
		source.tap(this.#tap);
	}
	detach(): void {
		this.#source.untap(this.#tap);
		this.clear();
	}
}
