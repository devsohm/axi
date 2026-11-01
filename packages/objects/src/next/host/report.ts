import type { FailureCause } from "../data/index.ts";
import type { RegistryError } from "../registries/record.ts";
import type { BatchError } from "../state/internal.ts";

export type Position = {
	readonly kind: "on" | "onLive" | "native";
	readonly position: number;
};
export type HostError =
	| BatchError
	| RegistryError
	| {
			readonly kind: "activation_failed";
			readonly object: string;
			readonly failure: FailureCause;
	  }
	| {
			readonly kind: "object_failed";
			readonly object: string;
			readonly failure: FailureCause;
	  }
	| { readonly kind: "storage_failed"; readonly error: unknown }
	| { readonly kind: "protocol_error"; readonly error: unknown }
	| {
			readonly kind: "close_failed";
			readonly object: string;
			readonly native: Position;
			readonly error: unknown;
	  }
	| {
			readonly kind: "close_timeout";
			readonly object: string;
			readonly native: Position;
	  }
	| { readonly kind: "drain_timeout"; readonly object: string }
	| {
			readonly kind: "resolve_failed";
			readonly address: string;
			readonly error: unknown;
	  }
	| {
			readonly kind: "derive_failed";
			readonly object: string;
			readonly member?: string;
			readonly error: unknown;
	  }
	| {
			readonly kind: "routine_failed";
			readonly object: string;
			readonly routine: Position;
			readonly error: unknown;
	  }
	| {
			readonly kind: "job_failed";
			readonly object: string;
			readonly job: string;
			readonly id: string;
			readonly error: unknown;
	  }
	| {
			readonly kind: "job_finish_failed";
			readonly object: string;
			readonly job: string;
			readonly id: string;
			readonly error: unknown;
	  }
	| {
			readonly kind: "job_interrupted";
			readonly object: string;
			readonly job: string;
			readonly id: string;
			readonly restarts: number;
	  }
	| {
			readonly kind: "job_dropped";
			readonly object: string;
			readonly job: string;
			readonly id: string;
	  }
	| {
			readonly kind: "parked_long";
			readonly object: string;
			readonly waitingFor: string;
			readonly state: "loading" | "failed";
			readonly since: number;
	  };
