# MCP specification

## Scope and ownership

The client owns initialization, request IDs, pending responses, deadlines, cancellation, progress, server request handlers and notifications. Transports own framing and I/O. Authentication providers supply tokens and recover rejected authorization. Applications own permission decisions, browser interaction and credential persistence.

The root exports the client, transport classes, public protocol/content types, content conversion and errors. `/oauth` exports discovery, registration, PKCE, exchange, refresh, state providers, callback handling and their types. `/testing` exports the in-memory transport and connected-pair factory. MCP has no Code Mode dependency.

This client does not implement MCP servers, batch messages, protocol tasks, a sampling engine or legacy HTTP with SSE. Generic `request()` and `notify()` let applications use additional method names; applications must provide any required handlers and result validation.

## Connection lifecycle

States are `idle`, `connecting`, `connected` and `closed`. `connect()` is allowed only from idle. It starts the transport, exchanges `initialize`, validates the selected version and server metadata, sets the transport's protocol version, and sends `notifications/initialized`. Failure closes the client.

The requested version defaults to `2025-11-25`. Accepted versions are `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`. Negotiated version, server information, capabilities and instructions are available through getters.

Closing removes transport listeners, rejects pending requests, aborts active server handlers and closes the transport. Close listeners run once. Transport errors are reported without immediately rejecting all pending requests; transport closure rejects them. Clients do not reconnect after closure: create another client and transport.

## Requests, handlers and notifications

Request IDs increase from 1. Responses settle the corresponding pending request; unknown response IDs are reported as errors. JSON-RPC errors reject with `McpError`, retaining numeric code, message and optional data.

The default request timeout is 30,000 ms. Request options override it. Non-finite or non-positive timeouts do not arm a timer. A matching progress notification renews the timeout and calls `onProgress`. Progress uses an advertised `_meta.progressToken` and preserves existing metadata.

An aborted signal rejects with `McpAbortError`; a deadline rejects with `McpTimeoutError`. Non-initialization requests send `notifications/cancelled` on cancellation. Settling a request aborts its transport admission signal so authorization recovery cannot dispatch a late retry. This does not undo a request already sent.

The client answers server `ping` requests. Configured roots, supplied as a list or callback, enable `roots/list`. `setRequestHandler()` receives parameters and an abort signal; server cancellation aborts that signal. Removing a replaced handler does not remove its replacement. An absent handler produces a method-not-found response. Nullish handler results become an empty object.

Notification, error and close registration returns removal callbacks. Notification and progress callback failures are reported to error listeners. Applications own error-listener behavior.

## Tools and resources

`listTools()`, `listResources()` and `listResourceTemplates()` collect all pages. Empty or null cursors end pagination. Repeated cursors or more than 1,000 pages fail. Listed tools require a name and object input schema. Resources require a URI; templates require a URI template. A missing name falls back to that address. Page methods preserve the cursor for the next request.

`readResource()` validates that each result item has a URI and text or blob contents. `callTool()` preserves the result, including `structuredContent` of any JSON type and `isError`. Absent content becomes an empty list. An `isError` result is distinct from a JSON-RPC protocol failure.

`toLlmContent()` emits model-facing text and base64 images. It unwraps embedded text and image resources, describes audio/resource links/binary content with text, and falls back to formatted structured JSON when there are no content blocks.

## Stdio transport

Messages are UTF-8 JSON-RPC lines on stdin/stdout. Blank lines are ignored and CRLF is accepted. Invalid lines emit errors. The default message limit is 16 MiB. An incomplete final line reports an error when the process closes. Stderr is separately captured, with a default 64 KiB tail and optional callback.

Options configure command, arguments, directory, environment inheritance, stderr mode, limits and close timeout. Environment inheritance is enabled by default. Closing ends stdin, allows up to 500 ms of grace, then sends SIGTERM and later SIGKILL. The default delay after SIGTERM is 2,000 ms. Unix process groups include descendants; Windows uses process-tree termination. Actual native process behavior must be tested on the deployment platform.

## Streamable HTTP transport

POST sends JSON and accepts JSON or SSE. Notifications and responses discard their acknowledgement body. A request acknowledged with 202 or 204 without a result fails. HTTP errors retain status and a bounded body snippet. A 401 becomes `McpAuthRequiredError`; a 404 after session establishment becomes `McpSessionExpiredError`.

The transport retains session IDs and negotiated protocol headers. By default it opens a server-to-client GET stream after initialization; `openGetStream: false` disables it. A 405 means no GET stream is offered. Injected `fetch` is called without a receiver.

SSE parsing handles chunked UTF-8, CRLF, comments, multiline data, IDs and retry hints. Event data and unfinished lines are bounded by `maxMessageBytes`, defaulting to 16 MiB. Identified response streams resume with GET and `Last-Event-ID`; streams without an ID cannot resume. A broken response stream fails its request without closing unrelated requests.

GET reconnection defaults to a 1,000 ms initial delay, 30,000 ms backoff cap and five consecutive retries. Server retry hints take precedence. Network failures, 408, 429 and server errors are retryable; authorization, session and protocol failures are not. Received events or a sufficiently long healthy GET stream reset the retry count.

Closing aborts streams and attempts a session DELETE with a one-second timeout. It reuses the most recently supplied access token without asking the authentication provider to refresh.

## OAuth flow

Discovery checks protected-resource metadata, then authorization-server or OpenID metadata candidates. Discovery misses may fall through; network failures propagate. Issuers are validated by default. An explicitly configured authorization-server metadata URL is trusted as configured and bypasses the discovery cache. Its URL and token endpoints require HTTPS except on loopback.

Protected-resource metadata must match the MCP server's origin and path. Scope selection considers the requested scope, resource-supported scopes and client metadata. Empty scopes fall through. Optional null or empty token fields are treated as absent.

Authorization uses PKCE S256, a saved verifier, optional state, redirect URI and resource indicator. It requires authorization-code support when metadata is available. `offline_access` requests consent. Client identification may use configured credentials, dynamic registration or a client metadata document. Registration derives native/web application type from redirect URIs unless explicitly set.

Code exchange checks `iss` against discovered metadata when supplied or promised by that metadata. An unverifiable supplied issuer fails. Token requests support basic, post, public-client or custom authentication. Refresh preserves the previous refresh token when the response omits one. Token responses inherit requested or previously granted scopes when no scope is returned.

`invalid_client` and `unauthorized_client` invalidate credentials and retry the flow once. `invalid_grant` invalidates tokens and retries once. A cancelled refresh does not fall back to an interactive redirect. Callers can supply an abort signal to discovery and token-flow operations.

`adaptOAuthProvider()` shares recovery between concurrent unauthorized responses and avoids refreshing again for a token already replaced. It retries authorization recovery after 401 or insufficient-scope 403 responses. Step-up authorization combines previously granted and challenged scopes and does not discard the current token before the new grant is obtained. A required redirect raises `McpOAuthAuthorizationRequiredError`.

## OAuth state and callbacks

`McpOAuthProvider` binds state to one exact normalized server URL. Configured client credentials take precedence over stored registration. Its default memory store returns detached copies; applications inject a store for persistence. Writes are serialized. Token expiration is recorded from `expires_in`. Invalidation can clear client, tokens, verifier, discovery or all state.

`OAuthCallbackServer.listen()` defaults to `127.0.0.1`, an ephemeral port, `/callback` and a five-minute wait. Options select advertised host, extra paths, timeout and page renderer. Callback state must match one pending wait. An optional expected path prevents accepting a response on another configured path. Duplicate pending states fail. OAuth errors, missing codes and expired state produce failed responses; successful results contain code, state and optional issuer.

Default callback pages are plain text. A custom renderer returns HTML with `cache-control: no-store`. Closing rejects pending waits, clears timers and closes the server. The application must close it on success and failure.
