# MCP

Connect to Model Context Protocol servers, discover tools and resources, call tools, and handle server notifications. MCP is independent of Code Mode. Your application decides which discovered tools a model or script can use.

## Connect a server

Create a `McpClient` with your application's name and version. Pass a `StdioTransport({ command, args })` for a local process, or `StreamableHttpTransport({ url, headers })` for a remote server. Connect before requesting tools, and close the client when finished.

This complete example uses the testing transport without an external server:

```ts
import { McpClient, LATEST_PROTOCOL_VERSION } from "@axi/mcp";
import { createInMemoryTransportPair } from "@axi/mcp/testing";

const pair = createInMemoryTransportPair();
pair.server.onMessage(message => {
	if (!("id" in message) || !("method" in message)) return;
	const result = message.method === "initialize"
		? { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "example", version: "1" } }
		: { tools: [{ name: "read", inputSchema: { type: "object" } }] };
	void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
});
await pair.server.start();
const client = new McpClient({ name: "example-client", version: "1" });
try {
	await client.connect(pair.client);
	console.log((await client.listTools()).map(tool => tool.name).join(","));
} finally {
	await client.close();
}
```

```text
read
```

`listTools()`, `listResources()` and `listResourceTemplates()` follow pagination. Resource helpers also expose individual pages. `callTool()` preserves structured content and `isError`; protocol errors reject with `McpError`. Requests accept `signal`, `timeoutMs` and `onProgress`.

Use `PipeTransport({ open })` when another component runs the server. The `open` callback connects stdout and stderr handlers and returns a pipe with `write`, `closeStdin`, `close` and an `exited` promise. The transport frames JSON-RPC messages, keeps a bounded stderr tail, and closes stdin before terminating an unresponsive server. It can connect to an Env remote process without spawning a local server.

`validateMcpServerConfig(name, entry)` validates shared stdio and HTTP settings and keeps application fields. `isMcpServerOverride(entry)` identifies entries that only override settings. `createMcpToolName(server, tool)` produces a provider-safe identifier, with a hash suffix for collisions or long names. `mcpNamespace(server)` gives the server's namespace. `normalizeMcpInputSchema(schema)` supplies missing object-schema fields.

## Convert tool results for a model

```ts
import { toLlmContent } from "@axi/mcp";

const content = toLlmContent({ content: [], structuredContent: { count: 3 } });
console.log(JSON.stringify(content));
```

```text
[{"type":"text","text":"{\n  \"count\": 3\n}"}]
```

Text and image blocks remain text and images. Embedded resources are unwrapped; other content becomes a short text placeholder.

Pass converted blocks to `limitMcpContent(content, saveOutput)` to limit combined text to 20 KiB, retaining its beginning and end. The optional saver receives the full text and returns a path. Images remain in the result. The result reports a save failure in its text without discarding the excerpt.

## Add authentication

Import OAuth helpers from `@axi/mcp/oauth`. `McpOAuthProvider` owns one exact server URL. Supply `McpOAuthStateStore` to persist credentials, and use `adaptOAuthProvider()` as the HTTP transport's `authProvider`. The library does not open a browser.

For application-managed sign-in, use `createMcpAuthProvider()` for HTTP requests. Supply a store with `withRefreshLock()` to serialize refreshes across processes. Call `settled()` before shutdown so rotated tokens finish saving. The provider reports a challenge when the user must sign in; it does not launch a browser.

`startMcpSignIn(options)` returns either `authorized` after a refresh or a `redirect` record for the browser. Keep the same options and pass the record with the callback response to `completeMcpSignIn()`. Use `listenForLoopbackSignIn()` and `waitForLoopbackSignIn()` for a local callback, or `responseFromRedirectUrl()` for a URL pasted from the browser. Abort a sign-in with its signal and close the callback server in `finally`. A refresh already in progress still saves its result when sign-in is cancelled.

When authorization requires interaction, the adapter raises `McpOAuthAuthorizationRequiredError`. Your application opens the URL passed to `onRedirect`, waits for a callback, and passes both `code` and `iss` to `authorizeMcp()`. Always close the callback server when finished.

This example verifies local callback handling without starting an external authorization flow:

```ts
import { OAuthCallbackServer } from "@axi/mcp/oauth";

const callback = await OAuthCallbackServer.listen();
try {
	const pending = callback.waitForCallback("local-state");
	const response = await fetch(`${callback.redirectUrl}?state=local-state&code=local-code`);
	await response.text();
	console.log((await pending).code);
} finally {
	await callback.close();
}
```

```text
local-code
```

See the [specification](docs/spec.md) for lifecycle, transport limits, authentication and supported protocol methods.

[API reference](docs/api.md)
