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

`ToolCallArgumentsStream` consumes argument fragments without reparsing the complete string on each fragment. It exposes immutable previews and incremental `set` or `append` changes. `StreamingJsonParser` provides the lower-level parser. Completed calls still pass through final JSON parsing and tool validation.

Final chat reasons are `stop`, `length`, `toolUse`, `error`, `aborted`, and `deferred`. An error result can retain partial content. Inspect the final reason before treating a response as successful. The assistant message also carries usage, cost estimates, provider identity, and optional response diagnostics.

## Transcripts and tools

`Context` contains `messages` and optional initial `systemPrompt` and `tools`. Messages use the `system`, `user`, `assistant`, and `toolResult` roles. Text, images, signed thinking, tool calls, and tool results remain structured content.

`normalizeContext()` converts the initial prompt and declarations into a `TranscriptContext`. Later system messages can add text, replace named sections, and add or remove tool declarations. A transport preserves those updates in place when its model capabilities permit them. Other transports replay the current combined prompt and tool set.

`resolveTranscriptTools(messages, support)` separates top-level declarations from changes kept in the transcript. `"none"` sends the current tools at the top level. `"additions"` folds changes through the last removal or repeated name, then keeps later additions in place. `"changes"` leaves the top-level list empty and declares every tool in place, including the initial tools. `foldedSystemMessages` counts the system messages already represented by the top-level list.

Responses transports that support system updates and `additional_tools` use `"changes"`. Later declarations replace earlier definitions. Removal notices tell the model which tools it must stop calling, because the wire format cannot remove declarations. Later updates repeat the names still unavailable. Restoring a tool removes its name from that notice. Synthetic tool search and supported Chat Completions tool messages use `"additions"`, so later loads preserve the cached prefix after a removal.

A `Tool` contains `name`, `description`, and a TypeBox `parameters` schema. Parameter schemas must be objects. The AI package describes calls. The application executes tools and appends their results. `validateToolArguments()` checks and coerces arguments against the declaration.

Non-strict Anthropic tools preserve an explicit `additionalProperties` policy, including a schema for extra arguments. Local definitions remain available to property references. Unsupported root schema combinators are omitted.

Validation copies the arguments, removes optional null properties, converts structural values, and then coerces explicitly declared primitive types. Serialized JSON schemas retain these conversions, including tuple prefixes, pattern properties and local references within their schema resource. Matching union values remain unchanged. Invalid converted values raise a validation error.

Numeric, boolean and string values can convert to `bigint`. A JSON `null` can convert to `undefined` when the schema requires it. These conversions leave the original transcript values intact. Validation reads an object's own fields; inherited methods do not count as arguments.

Recursive alternatives reuse completed conversions and diagnostics for the same schema and value. An active conversion does not enter itself again. Large enum schemas use interpreted validation if their generated validator exceeds the compiler's stack.

Local reference fragments decode URI escapes before JSON Pointer escapes. An unresolved or malformed reference rejects values at that field and names the reference in the diagnostic. An absent optional field does not fail because its reference is unresolved.

Type errors name the expected and received types. Each missing required field has its own diagnostic. Paths use decoded property names separated by dots. The error ends with the original arguments as formatted JSON, so callers can inspect what the model supplied before conversion.

Constraint errors explain bounds and allowed values. A failing union reports the branch selected by a distinct constant tag, or the branch declaring most of the supplied fields, with the deepest first failure breaking ties. Invalid declared fields appear before unknown fields in the same object.

`StringEnum` from `@axi/ai/utils/string-enum` creates a typed string schema with an `enum` array. Use it with providers that do not accept `anyOf` and `const` enum encodings. It accepts optional `description` and `default` fields.

Constrained sampling accepts JSON-schema preferences or grammar variants. JSON-schema strictness is `prefer` or `require`. Grammar formats are `openai_lark` and `openai_regex`. Support depends on the transport and model metadata.

A strict schema needs a type, a supported `anyOf`, or an `enum` at every node. An empty schema, an untyped value, or `const` alone makes `prefer` use ordinary tool sampling. With `require`, conversion fails before the request is sent. An enum without a type can still use strict sampling.

Google's optional legacy `parameters` conversion removes schema meta-declarations recursively. It copies fields by ordinary JavaScript assignment, so `__proto__` changes the copied object's prototype instead of becoming an own property. Mistral's schema copy uses the same assignment rule. Google's default `parametersJsonSchema` conversion preserves the original schema.

## Request options

The retry classifier treats a closed provider or proxy connection as a transient error. It also recognizes complete socket error codes such as `ECONNRESET`, `ECONNABORTED`, `ECONNREFUSED`, `ETIMEDOUT` and `EPIPE`, and a connection reset by the peer. A code embedded in a longer identifier does not match. Account, quota and billing limits take precedence, even when the same message also mentions a closed connection. Callers still apply their retry policy and attempt limit.

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
| `disableContinuation` | Sends a complete request without consuming or updating a session's continuation checkpoint. |
| `telemetry`, `metadata` | Supplies a callback span and provider metadata. |
| `identity` | Overrides the client's user agent, version and attribution for a request. |

Simple requests also accept `reasoning`, `toolChoice`, `thinkingBudgets`, and `deferred`. API-specific options expose provider controls without making them shared requirements. The API option types are exported from the package root.

`withClientIdentity(models, identity)` supplies identity defaults while forwarding the model registry's operations. Request identity fields override those defaults. The wrapper preserves a mutable registry's registration methods and reads each mutation method when it is called. A read-only registry stays read-only.

Codex resolves client identity once per request. A WebSocket attempt and its HTTP fallback use the same identity headers.
Bedrock resolves the user-agent mode once during client setup.

Simple requests merge model sampling defaults, thinking-level defaults, and request sampling parameters in that order. They clamp the requested output allowance to the estimated remaining context. `getSupportedThinkingLevels()` reads model capabilities. `clampThinkingLevel()` selects a supported level.

The model collection resolves authentication before invoking a provider. Per-request headers override resolved headers without regard to case. `transformHeaders` receives the combined headers before dispatch. An `onPayload` callback does not replace the authentication operation.

## Prompt cache warming

These helpers calculate policy. They do not start timers, make requests or modify session state.

- `getPromptCacheTtlMs(model, options)` converts the selected `model.promptCache` lifetime from seconds to milliseconds. An explicit `cacheRetention` takes precedence. Otherwise, `AXI_CACHE_RETENTION=long` selects long retention; other values select short retention. Request `env` values take precedence over the process environment when nonempty. `none` or an unknown lifetime returns `undefined`.
- `getCacheWarmingDelayMs(ttlMs)` returns `undefined` for a lifetime of at most 10 seconds. Otherwise it returns the earlier of 90% of the lifetime and 10 seconds before expiry, rounded down to milliseconds, with a minimum of 1 millisecond.
- `isCacheWarmingReplayable(model, options)` rejects Anthropic Messages requests with reasoning unless `compat.forceAdaptiveThinking` is true. Budget-based thinking can change the cached request when the output limit changes. Other requests are replayable.
- `getCacheWarmingRequestOptions(options, signal)` returns a new options object with `maxTokens: 1`, `maxRetries: 0`, `disableContinuation: true` and the supplied cancellation signal. Other fields keep their values.
- `evaluateCacheWarming(model, promptTokens, phase)` returns costs, a continuation estimate, expected savings, whether economics are available and a `warm` or `stop` action. All costs use `calculateCost()`, including model pricing tiers.

A refresh costs one cache read plus one output token. The miss cost is the extra cost of a future cache miss over a cache hit, with a minimum of zero. It uses cache-write pricing when positive and input pricing otherwise. The continuation probability is 1 for `streaming` and 0.15 for `idle`. Expected savings equal continuation probability times miss cost, minus refresh cost. Savings of at least USD 0.05 select `warm`. Economics are available only with a positive prompt size and a positive cache-hit or cache-miss price.

Applications schedule and cancel refreshes. The exported limits are `CACHE_WARMING_MAX_AGE_MS` (one hour), `CACHE_WARMING_MAX_IDLE_AGE_MS` (30 minutes), `CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS` (USD 0.05), and `CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY` (0.15). The helpers do not enforce the age limits; an application must apply them to its timers and stop warming when the request is replaced or the conversation ends.

## Authentication and storage

`Credential` is either an `api_key` record or an `oauth` record. API-key records contain an optional key and provider environment values. OAuth records contain access and refresh tokens, an expiry timestamp, and provider fields.

A persistent `CredentialStore` implements `read`, `list`, `modify`, and `delete`. Serialize modifications for each provider. `modify` receives the current record and returns its replacement. Returning `undefined` retains the current record. Use `delete` to remove one. Respect operation cancellation before publishing changes.

`AuthContext` supplies asynchronous `env(name)` and `fileExists(path)` methods. The default context reads process environment values and checks local files. A browser or remote host can supply another context.

Qwen Token Plan resolves a nonempty plan key before the regional fallback:

| Provider | Plan key | Regional fallback |
| --- | --- | --- |
| `qwen-token-plan` | `QWEN_TOKEN_PLAN_TEAM_API_KEY` | `QWEN_TOKEN_PLAN_API_KEY` |
| `qwen-token-plan-cn` | `QWEN_TOKEN_PLAN_TEAM_CN_API_KEY` | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| `qwen-token-plan-individual` | `QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY` | `QWEN_TOKEN_PLAN_API_KEY` |
| `qwen-token-plan-individual-cn` | `QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY` | `QWEN_TOKEN_PLAN_CN_API_KEY` |

The international gateway is `https://token-plan.maas.qwencloudapi.com/compatible-mode/v1`; China uses `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1`. Team and Individual credentials remain isolated. Catalog generation removes deprecated entries and limits Individual catalogs to the documented model set.

`AuthInteraction` supplies `prompt` and `notify`, plus an optional cancellation signal. Prompts distinguish text, secrets, manual codes, and selections. Notifications distinguish information, authorization URLs, device codes, and progress. The host owns display and input. Device-code events can set `openBrowserOnConfirm` and `copyCodeOnConfirm`. Both default to true: a host can offer to open the browser or copy the code after confirmation. These are UI hints; the host may ignore them. Copying replaces the current clipboard contents.

`models.login()` uses the registered provider's login method. Expired OAuth credentials refresh through the credential store. Logout deletes the stored record. Login availability and model availability are separate checks.

A configuration check uses the API-key authentication method selected at its start. Replacing that method does not redirect a check that is already running.

Google requests retain the selected API key during client setup. Vertex's application-credential setup selects its project and location before reading request headers. Request headers resolve before client identity.

Anthropic API-key requests use `x-api-key`. OAuth and Copilot requests use bearer authentication. Request headers can replace or remove those headers. A gateway using only `cf-aig-authorization` must also set `Authorization: null` to suppress the SDK's ordinary authentication requirement. The adapter does not load the SDK's ambient credential profiles.

Anthropic workload identity requires `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, and `ANTHROPIC_IDENTITY_TOKEN_FILE`. Optional `ANTHROPIC_WORKSPACE_ID` and `ANTHROPIC_SERVICE_ACCOUNT_ID` scope the token exchange. A resolved key or authentication header takes precedence. The SDK reads the identity file, exchanges its assertion, and caches the access token. Calls with the same endpoint, federation configuration and fetch implementation share that cache. Request-specific headers remain separate.

OAuth resolution refreshes tokens with at most five minutes remaining, or a larger requested `minOAuthValidityMs`. Concurrent requests check expiry again under the credential lock. Cancellation stops a caller waiting for that lock. After a refresh starts, it has a separate 15-second timeout and still saves the result if the caller cancels, because the previous refresh token may no longer work. An explicit `minOAuthValidityMs` also checks the refreshed token; the ordinary five-minute window only triggers refresh.

## Catalog refresh

`ModelsStore` implements `read`, `write`, and `delete` for provider catalog snapshots. `refresh({ allowNetwork: false })` restores stored overlays without a network fetch. Network refresh is enabled by default. `providers`, `force`, and `signal` narrow or cancel the operation. The result reports `aborted` and a map of provider errors.

A custom provider's `refreshModels()` receives the stored snapshot, resolved credential, network permission, cancellation signal, and `publish()` callback. Publish persistent and in-memory changes together. Superseded refreshes cannot publish into the current provider generation.

The build-time catalog generator accepts token prices with an omitted unit or the unit `token`. Other units are ignored. An output-price override creates a context tier only when it supplies a price; input cache overrides can create a tier without replacing the token price.

## Provider composition

`createProvider()` accepts a provider identity, authentication methods, model definitions, and operation adapters. Supply a shared chat adapter or an API-keyed adapter map. Image and classifier adapters use separate maps. At least one operation adapter is required.

`fetchModels` supplies dynamic model overlays. `filterModels` and `filterAllModels` filter availability for the resolved credential. Overlay identity includes both model type and model ID, so chat and image operations can share an ID.

`Model` includes its API, provider, endpoint, input modalities, limits, costs, reasoning capabilities, and optional compatibility metadata. `ImageModel` also declares output modalities. `ClassifierModel` declares its classifier API and context limit.

`ProviderCompat` from `@axi/ai/providers/compat-schema` types provider-wide and model-specific compatibility overrides. It is derived from `ProviderCompatSchema`, including the supported cache, reasoning and routing fields.

Chat Completions requests omit `tools` when no tools are declared. Set `compat.requiresToolsWithToolHistory` to true for a proxy that requires `tools: []` when replaying tool calls or results. It defaults to false.

## Images and classifiers

`ImagesContext` contains text and image input. `AssistantImages` returns text and image output with `stop`, `error`, or `aborted` status. Images carry base64 data and MIME types.

Image requests resolve request headers before selecting their fetch implementation and client identity.

`ClassifierContext` contains JSON `state`, named `questions`, and optional images. Questions request a choice, a score, or a boolean probability. Answers retain those types. Classifier support and image input support depend on the selected model.

System One classifiers select their image encoding through `compat.imageInput`. `assets` sends referenced PNG or JPEG assets. `images` sends up to four PNG, JPEG or WebP data URLs. `state-image-urls` places image URL parts before the state. Missing settings are detected from provider, endpoint and model ID. `compat.sendImageOptInHeader` controls the experimental TypeSafe image header; requests without images do not add it. Text-only models reject image input before sending a request.

The catalog marks supported image input and the required encoding explicitly. This keeps the encoding stable when an endpoint is replaced with a proxy.

## Deferred work and session resources

A deferred chat result carries a provider handle. Persist that handle in the application. Use `fetchDeferred()` or `streamDeferred()` to retrieve it. Use `cancelDeferred()` when the supporting provider permits cancellation. Ordinary streaming and deferred retrieval use separate operations.

`cleanupSessionResources(sessionId?)` releases transport resources registered for a session. Omitting the session ID requests cleanup of all sessions. It runs every registered cleanup and reports combined failures. The application owns when sessions end.

Anthropic and Bedrock share session-level strict-tool fallback state. After a schema-capacity rejection, later requests with that session ID send preferred strict tools without strict sampling. Required strict tools stay strict. Session cleanup clears the fallback. At most 10,000 session IDs are retained, with oldest-insertion eviction; requests without a session ID do not retain this state.

`Provider.refreshModelsAuth` controls authentication for the network catalog phase. `"credential"`, the default, resolves credentials and refreshes expired OAuth. `"configured"` checks whether authentication is configured, then calls the source with no credential and without refreshing OAuth. Local cache hydration still receives the stored credential. An offline refresh runs no network phase.

## Module entry points

The package root exposes isolated model collections, public types, authentication contracts, transcript helpers, validation, event streams, diagnostics, and the scripted provider. `@axi/ai/models` exposes model operations. `@axi/ai/providers/*` exposes individual provider factories. `@axi/ai/api/*` exposes transport adapters.

`@axi/ai/oauth` exports types for OAuth integrations. Use `models.login()` to run a registered provider's login flow. `@axi/ai/bedrock-provider` exposes the Bedrock provider. `@axi/ai/compat` exposes the optional process-wide API registry. `@axi/ai/utils/*` exposes individual utilities. Prefer an isolated collection when separate consumers must not share registrations.

`@axi/ai/session-resources` exports session resource registration and cleanup without importing the complete model collection.

## Request observation

The `telemetry` option accepts a `TelemetrySpan`. The model registry emits one logical request span around authentication and dispatch, or one poll span around a deferred fetch. Spans settle when the forwarded source result is observed.

`AI_TELEMETRY_SCHEMA` defines `axi.ai.request`, `axi.ai.poll`, first-chunk and block events, and request-duration, first-chunk-duration, token and cost metrics. Block events contain lengths and tool names without inspecting arguments. Histogram measurements carry the request span as an exemplar. Instruments are cached by metrics-adapter identity. Pending and deferred polls emit durations but no usage counters. Error diagnostics are capped at 500 characters; cancellation remains `ok`.

## Reported billing totals

`Usage.cost.totalFromProvider` is true when the response supplies complete valid billing data. Otherwise, the total uses catalog rates. OpenRouter BYOK responses include both the OpenRouter charge and the upstream inference charge. The input, output, cache-read, and cache-write fields remain catalog estimates, so their sum can differ from a provider-reported total. Calling `calculateCost()` resets `totalFromProvider` to false.

## SDK protocol compatibility

The Anthropic adapter pins `anthropic-version` to `2023-06-01` unless caller headers override it. Updating the SDK does not silently change the request protocol. Compatible endpoints can still receive `temperature` when enabled by model compatibility settings and not suppressed by thinking controls.

Google and Vertex pass the supplied `fetch` to the SDK. When it is absent, they pass the current global fetch explicitly so the SDK keeps the global dispatcher's timeout behavior. This applies to model requests from Vertex API-key and application-credential clients. Application-credential token requests still use the authentication library's HTTP client.

Both adapters disable automatic continuation. A `CONTINUATION` finish returns `length`, retains partial output and the raw stop reason, and sends no continuation request. The caller decides whether to request more output.
