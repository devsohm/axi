import { ConverseStreamCommand, type ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { SimpleStreamOptions, StreamFunction } from "../types.ts";
import { collapseSystemMessages } from "../utils/transcript.ts";
import { bedrockClient } from "./bedrock-client.ts";
import { bedrockRequest, bedrockSimpleOptions } from "./bedrock-request.ts";
import { bedrockStream } from "./bedrock-stream.ts";
import type { BedrockOptions } from "./options.ts";
export type { BedrockOptions, BedrockThinkingDisplay } from "./options.ts";
export const stream: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (model, context, options = {}) => {
	const transcript = collapseSystemMessages(context);
	return bedrockStream(model, options, async () => {
		const { client, observedResponse } = bedrockClient(model, options),
			params = bedrockRequest(model, transcript, options);
		const replacement = await options.onPayload?.(params, model);
		const response = await client.send(
			new ConverseStreamCommand(replacement === undefined ? params : (replacement as ConverseStreamCommandInput)),
			{ abortSignal: options.signal },
		);
		return { response, observed: observedResponse() };
	});
};
export const streamSimple: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model,
	context,
	options = {},
) => stream(model, context, bedrockSimpleOptions(model, context, options));
