import { objectsMetrics } from "../telemetry.ts";
import type { Context } from "../context/index.ts";
import type { Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import type { Static, TSchema } from "../contracts/index.ts";
import { fingerprintOf } from "../contracts/fingerprint.ts";
import { checkName } from "../contracts/names.ts";
import { snapshotSchema } from "../contracts/snapshot.ts";
import { validatorFor } from "../data/validator.ts";

export type JsonObject = { [key: string]: JsonValue };
export type CommitPersistence =
	| { readonly kind: "immediate" }
	| { readonly kind: "deferred"; readonly withinMs?: number };
export type CheckpointInfo = { readonly deltasSinceBase: number };
export type CheckpointWhen<T> = (
	value: T,
	ops: readonly Op[],
	info: CheckpointInfo,
) => boolean;
type DocumentOf<S extends TSchema> = Static<S> extends JsonObject
	? Static<S>
	: never;
type StateOptions<S extends TSchema, K extends boolean> = {
	readonly schema: S;
	readonly version: number;
	readonly initial: () => DocumentOf<S>;
	readonly migrate?: (old: JsonObject, from: number) => DocumentOf<S>;
	readonly keyed?: K;
};

export function defineState<S extends TSchema, K extends boolean = false>(
	name: string,
	options: StateOptions<S, K> & {
		readonly persist?: false;
		readonly checkpointWhen?: never;
	},
): StateDefinition<DocumentOf<S>, K, false>;
export function defineState<S extends TSchema, K extends boolean = false>(
	name: string,
	options: StateOptions<S, K> & {
		readonly persist: true;
		readonly checkpointWhen: CheckpointWhen<DocumentOf<S>>;
	},
): StateDefinition<DocumentOf<S>, K, true>;
export function defineState<S extends TSchema, K extends boolean>(
	name: string,
	options: StateOptions<S, K> & {
		readonly persist?: boolean;
		readonly checkpointWhen?: CheckpointWhen<DocumentOf<S>>;
	},
): StateDefinition<DocumentOf<S>, K, boolean> {
	checkName(name, "A state name");
	return new StateDefinition(
		name,
		options.schema,
		options.version,
		options.initial,
		options.migrate,
		options.keyed ?? false,
		options.persist ?? false,
		options.checkpointWhen,
	);
}

export class StateDefinition<
	T extends JsonObject,
	K extends boolean,
	P extends boolean = false,
> {
	readonly name: string;
	readonly schema: TSchema;
	readonly version: number;
	readonly keyed: boolean;
	readonly persist: boolean;
	readonly fingerprint: string;
	declare readonly "~keyed"?: K;
	declare readonly "~persist"?: P;
	readonly #create: () => T;
	readonly #upgrade: ((old: JsonObject, from: number) => T) | undefined;
	readonly #checkpoint: {
		apply(value: T, ops: readonly Op[], info: CheckpointInfo): boolean;
	}["apply"];
	#validatedInitial = false;

	constructor(
		name: string,
		schema: TSchema,
		version: number,
		initial: () => T,
		migrate: ((old: JsonObject, from: number) => T) | undefined,
		keyed: boolean,
		persist: boolean,
		checkpointWhen: CheckpointWhen<T> | undefined,
	) {
		this.name = name;
		this.schema = schema;
		this.version = version;
		this.keyed = keyed;
		this.persist = persist;
		this.fingerprint = fingerprintOf(snapshotSchema(schema, name).normal);
		this.#create = initial;
		this.#upgrade = migrate;
		this.#checkpoint = checkpointWhen ?? (() => false);
	}
	checkpointWhen(value: T, ops: readonly Op[], info: CheckpointInfo): boolean {
		return this.#checkpoint(value, ops, info);
	}
	initial(context: Context): T {
		const value = this.#create();
		if (!this.#validatedInitial) {
			this.#validate(value, "initial()", context);
			this.#validatedInitial = true;
		}
		return value;
	}
	migrate(old: JsonObject, from: number, context: Context): T {
		if (!this.#upgrade)
			throw new Error(
				`${this.name}: no migrate from version ${from} to ${this.version}`,
			);
		const value = this.#upgrade(old, from);
		this.#validate(value, `migrate() from version ${from}`, context);
		return value;
	}
	#validate(value: T, operation: string, context: Context): void {
		objectsMetrics(context.telemetry.metrics).counter("objects.data.validations").add(1);
		if (!validatorFor(this, context).check(value))
			throw new Error(`${this.name}: ${operation} does not match the schema`);
	}
}
