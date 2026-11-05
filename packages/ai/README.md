# @axi/ai

Typed model requests, transcript handling and provider composition.

The model runtime and scripted provider work without credentials:

```ts
import { contentText, createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";

const scripted = fauxProvider();
scripted.setResponses([fauxAssistantMessage("Ready.")]);
const models = createModels();
models.setProvider(scripted.provider);

const response = await models.completeSimple(scripted.getModel(), {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});
console.log(contentText(response.content));
```

```text
Ready.
```

Providers own their authentication, catalogs and request implementations. `createModels()` resolves credentials and delegates requests. `createProvider()` combines chat, image and classifier implementations. Applications can inject credential and model stores.

Register individual providers to load only their catalogs, or use the explicit collection of built-in providers:

```ts
import { builtinModels } from "@axi/ai/providers/all";

const models = builtinModels();
const model = models.getModel("openai", "gpt-4o-mini");
console.log(model?.id);
```

```text
gpt-4o-mini
```

The built-in catalog contains 41 providers. Chat, image and classifier entries share provider authentication but use separate operations. Catalog reads are synchronous. `models.refresh()` updates dynamic providers and can restore their persisted catalogs without network access.

Transcripts carry system messages and tool changes. The helpers replay the current prompt and tools, or retain updates in place for transports that support them. Event streams expose text, thinking and tool-call updates and return the completed assistant message.

Supported Responses models keep tool declarations in the input history, so removals and later loads preserve the existing request prefix. Addition-only transports fold changes through the last removal or redeclaration, then retain later additions in place. See [transcripts and tools](docs/spec.md#transcripts-and-tools) for the transport rules.

OpenAI Chat Completions and OpenAI/Azure Responses adapters use the OpenAI SDK. They support request and response callbacks, streaming tool arguments, grammar tools, retries and cache controls. Anthropic Messages uses the Anthropic SDK, with signed thinking replay, inline tool changes, strict-tool fallback and workload identity federation. You can use an adapter directly:

```ts
import { normalizeContext, type Model } from "@axi/ai";
import { streamSimple } from "@axi/ai/api/openai-responses";

export function request(model: Model<"openai-responses">, apiKey: string) {
	const transcript = normalizeContext({
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	});
	return streamSimple(model, transcript, { apiKey }).result();
}
```

Anthropic requests with a `sessionId` use server-side message threads on the Anthropic endpoint. After a completed reply, unchanged history is sent as a continuation with only the new messages. Changed prompts, tools or fixed request settings start a new thread. Thread rejection triggers one full-request fallback. Set `cacheRetention: "none"` to avoid threads, or `disableContinuation: true` for a replay such as cache warming. Call `cleanupSessionResources(sessionId)` when the session ends. Gateways must opt in with `compat.supportsMessageThreads`.

Login flows support legacy Codex, Anthropic, GitHub Copilot, OpenRouter, Kimi, Meta and xAI. The legacy Codex request adapter supports SSE, WebSockets, account-scoped connection reuse, continuation requests, and session cleanup. Newer ChatGPT sign-in and partner authentication are excluded. The `axi-ai list` command lists login providers. `axi-ai login <provider>` stores credentials in `auth.json` in the current directory.

For a Node bundle that splits dynamic imports, call `registerLazyOAuthFlows()` from `@axi/ai/lazy-oauth` and `registerLazyBedrockProvider()` from `@axi/ai/lazy-bedrock-provider` in its startup code. Their literal imports keep the included login flows and AWS implementation inside lazy chunks. The modules load on first use. Without these hooks, the default loaders resolve from the installed package. Keep these Node helpers out of browser bundles.

Image generation supports text and image input and returns text and embedded images. Classifiers support System One, Cloudflare System One, OpenAI Decisions and llama.cpp token-probability classification. Compose these adapters with `createProvider()` and custom model definitions.

GitHub Copilot exposes `microsoft-decision-1` through classifier accessors. It uses the authenticated account endpoint with `/v1/systemone`; chat and classifier catalogs stay separate.

The generic serialized message transport supports remote assistant events and diagnostic metadata. The optional `@axi/ai/compat` entry provides a global API registry and catalog access. Prefer a `Models` collection when separate applications or requests need independent configuration.

Google and Vertex use the Google SDK, with thinking controls, signature replay and image tool results. Vertex supports API keys and scoped application credentials. Bedrock uses the AWS SDK, with profile and bearer authentication, proxy routing, signed headers, encrypted reasoning and cache accounting. Mistral uses native HTTP and SSE, with thinking, tool arguments and prompt affinity. The Workers AI binding adapter forwards requests without changing their bodies or headers.

Maintainers can run `npm run generate:models --workspace @axi/ai` to fetch catalog sources and regenerate data and typed indexes. `--strict` rejects failed sources. `--data-only` updates existing data without rewriting types. `--json-only --json-output <directory>` exports catalogs without modifying package source. The build validates catalog structure and content hashes.

The generator lives in `catalog/generate.ts`. It reads models.dev v2, OpenRouter, NVIDIA and Vercel AI Gateway metadata. Protocol-specific endpoints determine routing where a provider lists several APIs. Provider corrections set verified limits, thinking controls and cache behavior. `scripts/hydrate-model-catalog.ts` imports an exported catalog; `catalog/check.ts` validates the generated files.

The [API contracts](docs/spec.md) describe collection methods, events, transcript changes, authentication, catalog publication, and session cleanup.

## Request telemetry

Pass a callback span as the request option `telemetry`. Keep the root adapter in your application. Model streams and deferred-response polls emit `axi.ai.request` and `axi.ai.poll` spans from authentication until the terminal result is observed. `AI_TELEMETRY_SCHEMA`, exported from the model module, describes the emitted fields.

Events record first-event delivery and completed block metadata: kind, index, UTF-16 character count and tool name. Attributes record provider, API, model, scalar reasoning level, stop reason, token usage, cost and response ID. Prompt text, generated text, thinking, tool arguments and deferred handles are not recorded. Error statuses use `provider_error` and at most 500 message characters; aborted requests remain successful telemetry operations.

Optional adapter metrics record request duration, time to first event, tokens and cost. Unfinished deferred polls do not increment token or cost counters. Request observation forwards the same stream events and result objects through one source iterator. Direct provider calls only forward the supplied span; automatic request instrumentation belongs to the model registry.

## Request identity

`createModels({ identity })` sets a default request identity. `withClientIdentity(models, identity)` adds a default to an existing collection. Each request can override individual fields. Set `attribution: null` to disable application attribution.

`userAgent` accepts `"short"`, `"detailed"`, or `{ custom: "my-app/1" }`. Detailed identity includes the package version, operating system, Node version and architecture. Attribution supplies a name, URL and optional categories for providers that support these headers. Explicit model and request headers take precedence.

[API reference](docs/api.md)
