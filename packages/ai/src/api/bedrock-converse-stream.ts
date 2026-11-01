import {
	BedrockRuntimeServiceException,
	ConverseStreamCommand,
	type ConverseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import type { SimpleStreamOptions, StreamFunction } from "../types.ts";
import { collapseSystemMessages, getCurrentTools } from "../utils/transcript.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { isStrictToolLimitErrorMessage, prefersJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import { bedrockClient } from "./bedrock-client.ts";
import { bedrockRequest, bedrockSimpleOptions } from "./bedrock-request.ts";
import { bedrockStream } from "./bedrock-stream.ts";
import type { BedrockOptions } from "./options.ts";
export type { BedrockOptions, BedrockThinkingDisplay } from "./options.ts";
export const stream: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (model, context, options = {}) => {
	const transcript = collapseSystemMessages(context);
	return bedrockStream(model, options, async (output) => {
		const { client, observedResponse } = bedrockClient(model, options);
		const preferredNames = new Set(
			getCurrentTools(transcript.messages)
				.filter(prefersJsonSchemaStrictSampling)
				.map((tool) => tool.name),
		);
		let disablePreferredStrict = false;
		for (;;) {
			const params = bedrockRequest(model, transcript, options, disablePreferredStrict);
			const preferred = params.toolConfig?.tools?.some(
				(tool) =>
					tool.toolSpec?.strict === true && tool.toolSpec.name !== undefined && preferredNames.has(tool.toolSpec.name),
			);
			const replacement = await options.onPayload?.(params, model);
			try {
				const response = await client.send(
					new ConverseStreamCommand(replacement === undefined ? params : (replacement as ConverseStreamCommandInput)),
					{ abortSignal: options.signal },
				);
				return { response, observed: observedResponse() };
			} catch (error) {
				if (
					disablePreferredStrict ||
					!preferred ||
					options.signal?.aborted ||
					!(error instanceof BedrockRuntimeServiceException) ||
					error.name !== "ValidationException" ||
					!isStrictToolLimitErrorMessage(error.message)
				)
					throw error;
				disablePreferredStrict = true;
				appendAssistantMessageDiagnostic(output, {
					type: "bedrock_strict_tools_fallback",
					timestamp: Date.now(),
					error: { message: error.message },
					details: { reason: "strict_tool_limits_exceeded" },
				});
			}
		}
	});
};
export const streamSimple: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model,
	context,
	options = {},
) => stream(model, context, bedrockSimpleOptions(model, context, options));
