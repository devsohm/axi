# AI contracts

This reference describes model collections, request data, authentication, and resource ownership. The [package overview](../README.md) introduces the entry points.

## Model collections
`createModels(options)` creates an isolated, mutable provider collection. The optional `credentials`, `modelsStore`, and `authContext` dependencies belong to that collection. The defaults store credentials and model overlays in memory.

| Operation | Result |
|---|---|
| `setProvider(provider)` | Registers or replaces a provider and supersedes its pending catalog refresh. |
| `deleteProvider(id)`, `clearProviders()` | Removes registrations and supersedes their pending refreshes. |
| `getProvider(id)`, `getProviders()` | Reads provider registrations. |
| `getModel(provider, id)`, `getModels(provider?)` | Reads chat models without checking credentials or fetching a catalog. |
| `getModelOfType(type, provider, id)`, `getModelsOfType(type, provider?)` | Reads image, classifier, or chat models. |
| `getAllModels(provider?)` | Reads every model type. |
| `getAvailable(provider?, options?)` | Checks authentication and returns available chat models. |
| `getAvailableOfType(type, provider?, options?)`, `getAllAvailable(provider?, options?)` | Checks authentication for the selected model types. |
| `checkAuth(provider, options?)` | Reports the selected authentication type and source. |
| `getAuth(providerOrModel, overrides?)` | Resolves credentials, request headers, environment values, and any authenticated base URL. |
| `login(provider, type, interaction, options?)` | Runs a supported API-key or OAuth login and saves the credential. |
| `logout(provider, options?)` | Deletes the stored credential. |
| `refresh(options?)` | Restores stored catalog overlays and optionally fetches fresh overlays. |
| `stream(model, context, options?)`, `complete(model, context, options?)` | Uses the options for the model's API. |
| `streamSimple(model, context, options?)`, `completeSimple(model, context, options?)` | Uses shared reasoning and tool-choice options. |
| `streamDeferred(model, handle, options?)`, `fetchDeferred(model, handle, options?)` | Retrieves a deferred request through a supporting provider. |
| `cancelDeferred(model, handle, options?)` | Cancels a deferred request through a supporting provider. |
| `generateImages(model, context, options?)` | Returns generated text and image content. |
| `classify(model, context, options?)` | Returns answers to structured classifier questions. |

A missing model lookup returns `undefined`. A missing provider, unsupported operation, or authentication failure has its own error path. A registered model is not evidence that credentials or a remote service are available.

## Streams and results

A chat stream is an async iterable with a `result()` method. Completion methods return that final result directly.

```ts
import { createModels, fauxAssistantMessage, fauxProvider } from "@axi/ai";

const scripted = fauxProvider();
scripted.setResponses([fauxAssistantMessage("Ready.")]);
const models = createModels();
models.setProvider(scripted.provider);
const stream = models.streamSimple(scripted.getModel(), {
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
});
for await (const event of stream) {
	if (event.type === "text_delta") process.stdout.write(event.delta);
}
const response = await stream.result();
if (response.stopReason === "error" || response.stopReason === "aborted") {
	throw new Error(response.errorMessage ?? response.stopReason);
}
```

The event types are `start`, `text_start`, `text_delta`, `text_end`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`, `done`, and `error`. Partial events carry the current assistant message. Tool argument deltas can contain incomplete JSON. Execute tools only after parsing and validating a completed call.

Read partial content when handling the event. Providers can mutate the same message and content blocks later.

Final chat reasons are `stop`, `length`, `toolUse`, `error`, `aborted`, and `deferred`. An error result can retain partial content. Inspect the final reason before treating a response as successful. The assistant message also carries usage, cost estimates, provider identity, and optional response diagnostics.

## Transcripts and tools

`Context` contains `messages` and optional initial `systemPrompt` and `tools`. Messages use the `system`, `user`, `assistant`, and `toolResult` roles. Text, images, signed thinking, tool calls, and tool results remain structured content.

`normalizeContext()` converts the initial prompt and declarations into a `TranscriptContext`. Later system messages can add text, replace named sections, and add or remove tool declarations. A transport preserves those updates in place when its model capabilities permit them. Other transports replay the current combined prompt and tool set.

A `Tool` contains `name`, `description`, and a TypeBox `parameters` schema. The AI package describes calls. The application executes tools and appends their results. `validateToolArguments()` checks and coerces arguments against the declaration.

Constrained sampling accepts JSON-schema preferences or grammar variants. JSON-schema strictness is `prefer` or `require`. Grammar formats are `openai_lark` and `openai_regex`. Support depends on the transport and model metadata.

## Request options

| Option | Purpose |
|---|---|
| `signal` | Cancels a request. |
| `apiKey`, `env`, `headers` | Supplies authentication and request configuration. |
| `fetch` | Supplies the HTTP implementation. |
| `timeoutMs`, `maxRetries`, `maxRetryDelayMs` | Configures transport timeout and retry behavior. |
| `onPayload` | Observes the serialized request and can return a replacement payload. |
| `onResponse` | Receives response status and headers. |
| `onProviderStreamEvent` | Observes raw chat-stream events on supporting transports. |
| `temperature`, `samplingParams`, `maxTokens` | Configures generation. |
| `transport`, `websocketConnectTimeoutMs` | Selects a supported stream transport and connection timeout. |
| `cacheRetention`, `sessionId` | Controls supported cache and session-affinity behavior. |
| `telemetry`, `metadata` | Supplies a callback span and provider metadata. |

Simple requests also accept `reasoning`, `toolChoice`, `thinkingBudgets`, and `deferred`. API-specific options expose provider controls without making them shared requirements. The API option types are exported from the package root.

Simple requests merge model sampling defaults, thinking-level defaults, and request sampling parameters in that order. They clamp the requested output allowance to the estimated remaining context. `getSupportedThinkingLevels()` reads model capabilities. `clampThinkingLevel()` selects a supported level.

The model collection resolves authentication before invoking a provider. Per-request headers override resolved headers without regard to case. `transformHeaders` receives the combined headers before dispatch. An `onPayload` callback does not replace the authentication operation.

## Authentication and storage

`Credential` is either an `api_key` record or an `oauth` record. API-key records contain an optional key and provider environment values. OAuth records contain access and refresh tokens, an expiry timestamp, and provider fields.

A persistent `CredentialStore` implements `read`, `list`, `modify`, and `delete`. Serialize modifications for each provider. `modify` receives the current record and returns its replacement. Returning `undefined` retains the current record. Use `delete` to remove one. Respect operation cancellation before publishing changes.

`AuthContext` supplies asynchronous `env(name)` and `fileExists(path)` methods. The default context reads process environment values and checks local files. A browser or remote host can supply another context.

`AuthInteraction` supplies `prompt` and `notify`, plus an optional cancellation signal. Prompts distinguish text, secrets, manual codes, and selections. Notifications distinguish information, authorization URLs, device codes, and progress. The host owns display and input.

`models.login()` uses the registered provider's login method. Expired OAuth credentials refresh through the credential store. Logout deletes the stored record. Login availability and model availability are separate checks.

## Catalog refresh

`ModelsStore` implements `read`, `write`, and `delete` for provider catalog snapshots. `refresh({ allowNetwork: false })` restores stored overlays without a network fetch. Network refresh is enabled by default. `providers`, `force`, and `signal` narrow or cancel the operation. The result reports `aborted` and a map of provider errors.

A custom provider's `refreshModels()` receives the stored snapshot, resolved credential, network permission, cancellation signal, and `publish()` callback. Publish persistent and in-memory changes together. Superseded refreshes cannot publish into the current provider generation.

## Provider composition

`createProvider()` accepts a provider identity, authentication methods, model definitions, and operation adapters. Supply a shared chat adapter or an API-keyed adapter map. Image and classifier adapters use separate maps. At least one operation adapter is required.

`fetchModels` supplies dynamic model overlays. `filterModels` and `filterAllModels` filter availability for the resolved credential. Overlay identity includes both model type and model ID, so chat and image operations can share an ID.

`Model` includes its API, provider, endpoint, input modalities, limits, costs, reasoning capabilities, and optional compatibility metadata. `ImageModel` also declares output modalities. `ClassifierModel` declares its classifier API and context limit.

## Images and classifiers

`ImagesContext` contains text and image input. `AssistantImages` returns text and image output with `stop`, `error`, or `aborted` status. Images carry base64 data and MIME types.

`ClassifierContext` contains JSON `state`, named `questions`, and optional images. Questions request a choice, a score, or a boolean probability. Answers retain those types. Classifier support and image input support depend on the selected model.

## Deferred work and session resources

A deferred chat result carries a provider handle. Persist that handle in the application. Use `fetchDeferred()` or `streamDeferred()` to retrieve it. Use `cancelDeferred()` when the supporting provider permits cancellation. Ordinary streaming and deferred retrieval use separate operations.

`cleanupSessionResources(sessionId?)` releases transport resources registered for a session. Omitting the session ID requests cleanup of all sessions. It runs every registered cleanup and reports combined failures. The application owns when sessions end.

## Module entry points

The package root exposes isolated model collections, public types, authentication contracts, transcript helpers, validation, event streams, diagnostics, and the scripted provider. `@axi/ai/models` exposes model operations. `@axi/ai/providers/*` exposes individual provider factories. `@axi/ai/api/*` exposes transport adapters.

`@axi/ai/oauth` exports types for OAuth integrations. Use `models.login()` to run a registered provider's login flow. `@axi/ai/bedrock-provider` exposes the Bedrock provider. `@axi/ai/compat` exposes the optional process-wide API registry. `@axi/ai/utils/*` exposes individual utilities. Prefer an isolated collection when separate consumers must not share registrations.

## Request observation

The `telemetry` option accepts a `TelemetrySpan`. The model registry emits one logical request span around authentication and dispatch, or one poll span around a deferred fetch. Spans settle when the forwarded source result is observed.

`AI_TELEMETRY_SCHEMA` defines `axi.ai.request`, `axi.ai.poll`, first-chunk and block events, and request-duration, first-chunk-duration, token and cost metrics. Block events contain lengths and tool names without inspecting arguments. Histogram measurements carry the request span as an exemplar. Instruments are cached by metrics-adapter identity. Pending and deferred polls emit durations but no usage counters. Error diagnostics are capped at 500 characters; cancellation remains `ok`.
