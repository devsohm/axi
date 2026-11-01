import { DurableObject } from "cloudflare:workers";
import type { CodemodeSandboxDurableObject } from "@axi/codemode/cloudflare";
import { RemoteCodemodeSandbox } from "@axi/codemode/portable";

interface Env {
	SESSION: DurableObjectNamespace<Session>;
	SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
}

export class Session extends DurableObject<Env> {
	private count = 0;

	async run(code: string) {
		const sandbox = new RemoteCodemodeSandbox({
			remote: () => this.env.SANDBOX.getByName(this.ctx.id.toString()),
			timeoutMs: 60_000,
			tools: [
				{
					name: "count",
					description: "Add to this session's counter",
					execute: (args) => (this.count += (args as { add: number }).add),
				},
			],
		});
		try {
			return await sandbox.execute(code);
		} finally {
			await sandbox.close();
		}
	}
}

export default {
	async fetch(request, env) {
		if (request.method !== "POST") return new Response("Send a script with POST\n", { status: 405 });
		const result = await env.SESSION.getByName("example").run(await request.text());
		return Response.json(result);
	},
} satisfies ExportedHandler<Env>;
