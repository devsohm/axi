import Type, { type TUnsafe } from "typebox";
import type { Context } from "../context/index.ts";
import type { JsonValue } from "../json.ts";
import type { Static, TSchema } from "../contracts/index.ts";
import { fingerprintOf } from "../contracts/fingerprint.ts";
import { snapshotSchema } from "../contracts/snapshot.ts";
import { ObjectsError } from "../data/index.ts";
import { validatorFor } from "../data/internal.ts";

export type JsonColumnOptions<T> = {
	readonly version: number;
	readonly migrate?: (old: JsonValue, from: number) => T;
};
export type JsonColumnSchema<T> = TUnsafe<T> & { readonly json: JsonColumn };
export function json<S extends TSchema>(
	schema: S,
	options: JsonColumnOptions<Static<S>>,
): JsonColumnSchema<Static<S>> {
	return Object.assign(Type.Unsafe<Static<S>>({}), {
		json: new JsonColumn(schema, options.version, options.migrate),
	});
}

export class JsonColumn {
	readonly schema: TSchema;
	readonly version: number;
	readonly fingerprint: string;
	readonly #migrate: ((old: JsonValue, from: number) => unknown) | undefined;
	constructor(
		schema: TSchema,
		version: number,
		migrate: ((old: JsonValue, from: number) => unknown) | undefined,
	) {
		if (!Number.isSafeInteger(version) || version < 1)
			throw new Error(
				`json(...): version ${version} is not a positive integer`,
			);
		const snapshot = snapshotSchema(schema, "json(...)");
		this.schema = snapshot.schema;
		this.version = version;
		this.fingerprint = fingerprintOf(snapshot.normal);
		this.#migrate = migrate;
	}
	read(text: string, version: number, what: string, context: Context): unknown {
		const value: JsonValue = JSON.parse(text);
		if (version === this.version) return value;
		if (version > this.version)
			throw new ObjectsError({
				code: "unavailable",
				message: `${what}: stored at version ${version}, newer than ${this.version}`,
			});
		if (!this.#migrate)
			throw new ObjectsError({
				code: "unavailable",
				message: `${what}: no migrate from version ${version} to ${this.version}`,
			});
		let migrated: unknown;
		try {
			migrated = this.#migrate(value, version);
		} catch (cause) {
			throw new ObjectsError(
				{
					code: "unavailable",
					message: `${what}: migrate from version ${version} threw`,
				},
				cause === undefined ? undefined : { cause },
			);
		}
		context.telemetry.metrics?.counter("objects.data.validations").add(1);
		if (!validatorFor(this, context).Check(migrated))
			throw new ObjectsError({
				code: "unavailable",
				message: `${what}: migrate from version ${version} does not match the schema`,
			});
		return migrated;
	}
}
