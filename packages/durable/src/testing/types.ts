import type { ExecutionEnv } from "../env/index.ts";
import type { Storage } from "../types.ts";

export interface StorageConformanceAssertions {
	ok(value: unknown, message?: string): void;
	strictEqual(actual: unknown, expected: unknown): void;
	deepEqual(actual: unknown, expected: unknown): void;
	partialDeepEqual(actual: unknown, expected: unknown): void;
	greaterThan(actual: number, expected: number): void;
	rejects(operation: Promise<unknown>, messageIncludes: string): Promise<void>;
}
export type StorageConformanceProvider = (use: (storage: Storage) => Promise<void>) => Promise<void>;
export interface StorageConformanceOptions {
	readonly assertions: StorageConformanceAssertions;
	readonly withStorage: StorageConformanceProvider;
}
export interface StorageConformanceCase {
	readonly name: string;
	run(): Promise<void>;
}
export type EnvConformanceAssertions = StorageConformanceAssertions;
export type EnvConformanceProvider = (use: (env: ExecutionEnv) => Promise<void>) => Promise<void>;
export interface EnvConformanceOptions {
	readonly assertions: EnvConformanceAssertions;
	readonly withEnv: EnvConformanceProvider;
	readonly shell?: readonly string[];
	readonly symlinks?: boolean;
	readonly listFiles?: boolean;
}
export interface EnvConformanceCase {
	readonly name: string;
	readonly timeoutMs?: number;
	run(): Promise<void>;
}
