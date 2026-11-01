import { checkKeys, entriesOf } from "../contracts/declare.ts";
import type { Static, TSchema } from "../contracts/index.ts";
import { hash64 } from "../contracts/fingerprint.ts";
import { checkName } from "../contracts/names.ts";
import {
	snapshotArguments,
	snapshotSchema,
	type Snapshot,
} from "../contracts/snapshot.ts";
import type { ObjectsError, PluginError } from "../data/index.ts";
import type { JsonObject, StateDefinition } from "../documents/index.ts";

export type JobPersistence = { readonly resume: "rerun" | "abandon" };
export type JobAccepts<
	A extends TSchema = TSchema,
	R extends TSchema = TSchema,
> = {
	readonly [version: number]: {
		readonly args: (old: never) => Static<A>;
		readonly result: (old: never) => Static<R>;
	};
};
export type JobOptions<
	A extends TSchema,
	R extends TSchema,
	D extends StateDefinition<JsonObject, false, boolean> | undefined,
> = {
	readonly version: number;
	readonly args: A;
	readonly result: R;
	readonly state?: D;
	readonly concurrency?: number;
	readonly accepts?: JobAccepts<A, R>;
	readonly persist?: JobPersistence;
};
type StateOf<D> = D extends StateDefinition<infer T, false, boolean>
	? T
	: undefined;
export type JobError =
	| { readonly kind: "threw"; readonly error: ObjectsError | PluginError }
	| {
			readonly kind: "aborted";
			readonly reason: "abort" | "reload" | "restart";
	  }
	| { readonly kind: "restart_limit"; readonly restarts: number };
export type Outcome<A, R, S> = {
	readonly id: string;
	readonly args: A;
	readonly state: S;
} & (
	| { readonly kind: "done"; readonly result: R }
	| { readonly kind: "failed"; readonly error: JobError }
);

export function defineJob<
	const A extends TSchema,
	const R extends TSchema,
	D extends StateDefinition<JsonObject, false, boolean> | undefined = undefined,
>(
	name: string,
	options: JobOptions<A, R, D>,
): JobDefinition<Static<A>, Static<R>, StateOf<D>> {
	checkName(name, "A job name");
	checkKeys(
		options,
		["version", "args", "result", "state", "concurrency", "accepts", "persist"],
		name,
	);
	const { version, state, concurrency, accepts, persist } = options;
	if (!Number.isSafeInteger(version) || version < 1)
		throw new Error(`${name}.version: expected a positive integer`);
	const args = snapshotArguments(options.args, `${name}.args`);
	if (args.bytes)
		throw new Error(
			`${name}.args: job arguments are JSON (running carries them); no bytes()`,
		);
	const result = snapshotSchema(options.result, `${name}.result`);
	if (state?.keyed)
		throw new Error(`${name}.state: expected a singleton document definition`);
	if (persist !== undefined) {
		checkKeys(persist, ["resume"], `${name}.persist`);
		if (persist.resume !== "rerun" && persist.resume !== "abandon")
			throw new Error(`${name}.persist.resume: expected "rerun" or "abandon"`);
		if (state && !state.persist)
			throw new Error(
				`${name}.state: a persisted job's state is a persisted document (persist: true)`,
			);
		if (result.bytes)
			throw new Error(
				`${name}.result: a persisted job's result is JSON (it is stored); no bytes()`,
			);
	}
	if (
		concurrency !== undefined &&
		(!Number.isSafeInteger(concurrency) || concurrency <= 0)
	)
		throw new Error(`${name}.concurrency: expected a positive integer`);
	if (accepts !== undefined) {
		for (const [key, adapter] of entriesOf(accepts, `${name}.accepts`)) {
			const previous = Number(key),
				path = `${name}.accepts[${key}]`;
			if (
				!Number.isSafeInteger(previous) ||
				previous < 1 ||
				previous >= version
			)
				throw new Error(`${path}: not an older version`);
			checkKeys(adapter, ["args", "result"], path);
			const fields = new Map(entriesOf(adapter, path));
			for (const field of ["args", "result"])
				if (typeof fields.get(field) !== "function")
					throw new Error(`${path}.${field}: expected a function`);
		}
	}
	const fingerprint = hash64(
		JSON.stringify({
			args: args.normal,
			result: result.normal,
			state: state?.fingerprint ?? null,
		}),
	);
	return new JobDefinition(
		name,
		version,
		args,
		result,
		state,
		concurrency,
		accepts ?? {},
		persist,
		fingerprint,
	);
}

export class JobDefinition<A, R, S> {
	readonly name: string;
	readonly version: number;
	readonly args: Snapshot;
	readonly result: Snapshot;
	readonly state: StateDefinition<JsonObject, false, boolean> | undefined;
	readonly concurrency: number | undefined;
	readonly accepts: JobAccepts;
	readonly persist: JobPersistence | undefined;
	readonly fingerprint: string;
	declare readonly "~types"?: {
		readonly args: A;
		readonly result: R;
		readonly state: S;
	};
	constructor(
		name: string,
		version: number,
		args: Snapshot,
		result: Snapshot,
		state: StateDefinition<JsonObject, false, boolean> | undefined,
		concurrency: number | undefined,
		accepts: JobAccepts,
		persist: JobPersistence | undefined,
		fingerprint: string,
	) {
		this.name = name;
		this.version = version;
		this.args = args;
		this.result = result;
		this.state = state;
		this.concurrency = concurrency;
		this.accepts = accepts;
		this.persist = persist;
		this.fingerprint = fingerprint;
	}
}
