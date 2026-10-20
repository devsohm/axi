const { createInterface } = require("node:readline");
process.stderr.write("worker-ready");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	let result;
	if (request.method === "initialize")
		result = {
			protocolVersion: request.params.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: process.env.AXI_MCP_TEST, version: "1" },
		};
	else if (request.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
	else if (request.method === "tools/call")
		result = { content: [{ type: "text", text: request.params.arguments.text }] };
	else {
		process.stdout.write("X".repeat(300) + "\n");
		result = "recovered";
	}
	const message = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\r\n");
	process.stdout.write(message.subarray(0, 7));
	setImmediate(() => process.stdout.write(message.subarray(7)));
});
