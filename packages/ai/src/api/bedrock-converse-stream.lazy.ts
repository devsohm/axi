import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";
let implementation: (() => Promise<ProviderStreams>) | undefined;
export function setBedrockProviderModule(module: ProviderStreams): void {
	implementation = async () => module;
}
export function setBedrockProviderLoader(loader: () => Promise<ProviderStreams>): void {
	implementation = loader;
}
const load = (specifier: string): Promise<ProviderStreams> =>
	import(
		new URL(import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier, import.meta.url).href
	);
export const bedrockConverseStreamApi = (): ProviderStreams =>
	lazyApi(() => (implementation ? implementation() : load("./bedrock-converse-stream.ts")));
