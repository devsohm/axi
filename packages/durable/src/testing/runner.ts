import { createExpectAssertions, type ExpectLike } from "./assertions.ts";
import { createEnvConformance } from "./env-conformance.ts";
import { createStorageConformance } from "./storage-conformance.ts";
import type { EnvConformanceOptions, EnvConformanceProvider, StorageConformanceProvider } from "./types.ts";

export interface StorageConformanceRunner {
	readonly describe: (name: string, suite: () => void) => unknown;
	readonly expect: ExpectLike;
	readonly it: (name: string, test: () => Promise<void>, timeoutMs?: number) => unknown;
}
export function registerStorageConformance(
	runner: StorageConformanceRunner,
	name: string,
	withStorage: StorageConformanceProvider,
): void {
	const cases = createStorageConformance({ assertions: createExpectAssertions(runner.expect), withStorage });
	runner.describe(name, () => {
		for (const test of cases) runner.it(test.name, test.run);
	});
}
export function registerEnvConformance(
	runner: StorageConformanceRunner,
	name: string,
	withEnv: EnvConformanceProvider,
	options: Pick<EnvConformanceOptions, "shell" | "symlinks" | "listFiles"> = {},
): void {
	const cases = createEnvConformance({ ...options, assertions: createExpectAssertions(runner.expect), withEnv });
	runner.describe(name, () => {
		for (const test of cases) runner.it(test.name, test.run, test.timeoutMs);
	});
}
