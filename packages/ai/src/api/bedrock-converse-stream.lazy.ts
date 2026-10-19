import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";
let implementation: ProviderStreams | undefined;
export function setBedrockProviderModule(module: ProviderStreams): void {
	implementation = module;
}
const load = (specifier: string): Promise<ProviderStreams> =>
	import(import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier);
export const bedrockConverseStreamApi = (): ProviderStreams =>
	lazyApi(async () => implementation ?? (await load("./bedrock-converse-stream.ts")));
