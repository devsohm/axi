import { isObjectsError, ObjectsError, type FailureCause } from "../data/index.ts";
import { asObjectsError, waitingFor } from "../data/internal.ts";
import type { RegistryValueSource } from "../registries/internal.ts";
import { LOADING, type Failed, type RefState } from "./ref-state.ts";
import type { Binding } from "./reference.ts";
import type { HostError } from "./report.ts";

export type Dependency =
	| { readonly kind: "reference"; readonly binding: Binding }
	| { readonly kind: "registry"; readonly value: RegistryValueSource };
type Blocker = { readonly label: string; readonly state: "loading" | "failed" };
export type Check =
	| { readonly kind: "live" }
	| { readonly kind: "broken"; readonly error: ObjectsError }
	| {
			readonly kind: "parked";
			readonly shown: RefState;
			readonly firstPass: boolean;
			readonly blocker: Blocker;
			readonly loadingOn: string | undefined;
	  };
const live: Check = { kind: "live" };
export function waitingOn(label: string, error: ObjectsError): Failed {
	return {
		kind: "failed",
		cause: waitingFor(label, error),
		retryAt: undefined,
	};
}
export function checkDependencies(dependencies: readonly Dependency[]): Check {
	let failed: Failed | undefined,
		blocker: Blocker | undefined,
		loadingOn: string | undefined,
		firstPass = true;
	for (const dependency of dependencies) {
		if (dependency.kind === "registry") {
			const value = dependency.value,
				start = value.start();
			if (start.kind !== "value" && start.last === undefined) {
				failed ??= waitingOn(`registry ${value.name}`, asObjectsError(start.error, `registry ${value.name}`));
				blocker ??= { label: `registry ${value.name}`, state: "failed" };
			}
			continue;
		}
		const binding = dependency.binding,
			state = binding.refState,
			target = binding.target;
		if (state.kind === "live") continue;
		if (state.kind === "ended") return { kind: "broken", error: state.error };
		if (state.kind === "failed") {
			const error = state.cause.error;
			if (isObjectsError(error, "forbidden") || (isObjectsError(error, "invalid") && error.reason === "cycle"))
				return { kind: "broken", error };
			failed ??= waitingOn(binding.label, error);
			blocker ??= { label: binding.label, state: "failed" };
		} else {
			loadingOn ??= binding.label;
			blocker ??= { label: binding.label, state: "loading" };
		}
		if (target?.blocksFirstPass) firstPass = false;
	}
	return blocker ? { kind: "parked", shown: failed ?? LOADING, firstPass, blocker, loadingOn } : live;
}
export function parkedCause(check: Extract<Check, { kind: "parked" }>): FailureCause {
	if (check.shown.kind === "failed") return check.shown.cause;
	const label = check.loadingOn ?? "a dependency";
	return waitingFor(label, new ObjectsError({ code: "unavailable", message: `${label} is loading` }));
}
type ParkingOwner = {
	readonly label: string;
	readonly host: {
		readonly timeouts: { readonly ready: number };
		report(error: HostError): void;
	};
};
export class ParkedLong {
	readonly #owner: ParkingOwner;
	readonly #since = Date.now();
	#blocker: Blocker | undefined;
	readonly #timer: ReturnType<typeof setTimeout>;
	constructor(owner: ParkingOwner) {
		this.#owner = owner;
		this.#timer = setTimeout(() => {
			if (this.#blocker === undefined) return;
			this.#owner.host.report({
				kind: "parked_long",
				object: this.#owner.label,
				waitingFor: this.#blocker.label,
				state: this.#blocker.state,
				since: this.#since,
			});
		}, this.#owner.host.timeouts.ready);
	}
	blockedBy(blocker: Blocker): void {
		this.#blocker = blocker;
	}
	stop(): void {
		clearTimeout(this.#timer);
	}
}
