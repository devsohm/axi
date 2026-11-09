import { setBedrockProviderLoader } from "./api/bedrock-converse-stream.lazy.ts";

export function registerLazyBedrockProvider(): void {
	setBedrockProviderLoader(() => import("./api/bedrock-converse-stream.ts"));
}
