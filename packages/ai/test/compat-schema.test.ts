import { expect, it } from "vitest";
import { Value } from "typebox/value";
import {
	AnthropicMessagesCompatSchema,
	OpenAICompletionsCompatSchema,
	ProviderCompatSchema,
} from "../src/providers/compat-schema.ts";

it("preserves endpoint detection when compatibility defaults are applied", () => {
	for (const schema of [AnthropicMessagesCompatSchema, ProviderCompatSchema]) {
		const settings = Value.Default(schema, {});
		expect(settings).not.toHaveProperty("supportsMessageThreads");
	}
	for (const schema of [OpenAICompletionsCompatSchema, ProviderCompatSchema]) {
		const settings = Value.Default(schema, {});
		expect(settings).not.toHaveProperty("requiresNonNullAssistantContent");
	}
});
