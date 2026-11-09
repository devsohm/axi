import type { JsonValue } from "../../json.ts";
import type { Address } from "../../contracts/index.ts";
import { ObjectsError, isObjectsError, type FailureCause } from "../../data/index.ts";
import { objectsErrorFromJson } from "../../data/internal.ts";
import type { ReloadReport } from "../../host/index.ts";
import type { PluginScript } from "../plugins/runtime.ts";
export type CrossedError = { readonly message: string; readonly code?: string; readonly reason?: string };
type CrossedCause = { readonly kind: FailureCause["kind"]; readonly error: CrossedError };
export type CrossedReport = {
	readonly plugins: ReloadReport["plugins"];
	readonly failed: readonly { readonly plugin: string; readonly error: CrossedError }[];
	readonly objects: readonly { readonly object: string; readonly kind: string; readonly cause?: CrossedCause }[];
};
export type ToWorker =
	| {
			readonly kind: "start";
			readonly address: Address;
			readonly start: JsonValue;
			readonly scripts: readonly PluginScript[];
			readonly lock: string;
	  }
	| { readonly kind: "shutdown" }
	| { readonly kind: "reload"; readonly scripts: readonly PluginScript[] };
export type FromWorker =
	| { readonly kind: "started" }
	| { readonly kind: "ready"; readonly idle: boolean; readonly report: CrossedReport }
	| { readonly kind: "idle"; readonly idle: boolean }
	| { readonly kind: "fatal"; readonly error: CrossedError }
	| { readonly kind: "reloaded"; readonly report: CrossedReport }
	| { readonly kind: "reloaded"; readonly error: CrossedError };
const key = "objects.workers";
export function envelope(message: ToWorker | FromWorker): { readonly [key]: ToWorker | FromWorker } {
	return { [key]: message };
}
export function controlOf<M extends ToWorker | FromWorker>(message: unknown): M | undefined {
	return typeof message === "object" && message !== null && key in message ? (message as { [key]: M })[key] : undefined;
}
export function crossed(error: unknown): CrossedError {
	if (isObjectsError(error))
		return {
			message: error.message,
			code: error.code,
			...(error.reason === undefined ? {} : { reason: error.reason }),
		};
	return { message: error instanceof Error ? error.message : String(error) };
}
export function uncrossed(error: CrossedError): Error {
	if (error.code !== undefined) {
		try {
			return objectsErrorFromJson({
				code: error.code,
				message: error.message,
				...(error.reason === undefined ? {} : { reason: error.reason }),
			});
		} catch {}
	}
	return new Error(error.message);
}
export function crossedReport(report: ReloadReport): CrossedReport {
	return {
		plugins: report.plugins,
		failed: report.failed.map((f) => ({ plugin: f.plugin, error: crossed(f.error) })),
		objects: report.objects.map((entry) =>
			entry.kind === "parked"
				? {
						object: entry.object,
						kind: entry.kind,
						cause: { kind: entry.cause.kind, error: crossed(entry.cause.error) },
					}
				: entry,
		),
	};
}
export function uncrossedReport(report: CrossedReport): ReloadReport {
	const objects: ReloadReport["objects"][number][] = report.objects.map((entry) => {
		if (!entry.cause)
			return { object: entry.object, kind: entry.kind as Exclude<ReloadReport["objects"][number]["kind"], "parked"> };
		const error = uncrossed(entry.cause.error);
		return {
			object: entry.object,
			kind: "parked",
			cause: {
				kind: entry.cause.kind,
				error: isObjectsError(error) ? error : new ObjectsError({ code: "unavailable", message: error.message }),
			} as FailureCause,
		};
	});
	return {
		plugins: report.plugins,
		objects,
		failed: report.failed.map((entry) => ({ plugin: entry.plugin, error: uncrossed(entry.error) })),
	};
}
