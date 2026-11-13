import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { BACKGROUND_CONTEXT as context } from "@axi/objects/context";
import { DurableObjectSqliteDatabase } from "@axi/objects/sqlite/cloudflare";
import { createSession, defineDoc, Harness, createRegistry, defineTool, ToolResultEntry } from "@axi/durable";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText, Type } from "@axi/ai";
import { openDurableObjectSqliteStorage } from "@axi/durable/storage/sqlite/cloudflare";
import { createInlineCodemodeSandbox, CodemodeSandboxDurableObject } from "@axi/codemode/cloudflare";
import { RemoteCodemodeSandbox } from "@axi/codemode/portable";
const coverage = () => ({
	context: (globalThis.__AXI_COVERAGE_CONTEXT__ ??= crypto.randomUUID()),
	data: globalThis.__VITEST_COVERAGE__ ?? {},
});
export class Sandbox extends CodemodeSandboxDurableObject {
	fetch() { return Response.json(coverage()); }
}
const Counter = defineDoc({
	checkpointWhen: () => false,
	kind: "runtime.counter",
	scope: "session",
	version: 1,
	initial: () => ({ count: 0 }),
});
export class State extends DurableObject {
	async fetch(request) {
		if (new URL(request.url).pathname === "/coverage") return Response.json(coverage());
		const db = new DurableObjectSqliteDatabase(this.ctx.storage);
		await db.exec("CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY, value TEXT)");
		await db.run("DELETE FROM checks");
		let expired;
		let inserted;
		await db.transaction(async (tx) => {
			expired = tx;
			inserted = await tx.runCounted("INSERT INTO checks VALUES (?,?)", 1, "committed");
		});
		let rejected = false;
		try {
			await expired.get("SELECT * FROM checks");
		} catch {
			rejected = true;
		}
		try {
			await db.transaction(async (tx) => {
				await tx.run("INSERT INTO checks VALUES (?,?)", 2, "rolled back");
				throw new Error("rollback");
			});
		} catch {}
		const rows = await db.all("SELECT * FROM checks ORDER BY id");
		const changed = await db.runCounted("UPDATE checks SET value = ? WHERE id = ?", "committed", 1);
		const bytes = Buffer.alloc(8);
		bytes.set([9, 8, 1, 2, 3, 7, 6, 5]);
		const binary = await db.get(
			"SELECT hex(?) AS typed, hex(?) AS buffer",
			new Uint8Array(bytes).subarray(2, 5),
			bytes.subarray(2, 5),
		);
		const binaryRead = await db.get("SELECT ? AS bytes", new Uint8Array([1, 2, 3]));
		const integers = await db.get("SELECT ? AS lower, ? AS upper", BigInt(Number.MIN_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
		let precisionErrors = 0;
		for (const value of [BigInt(Number.MIN_SAFE_INTEGER) - 1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
			try { await db.get("SELECT ? AS value", value); } catch (error) {
				if (!(error instanceof RangeError)) throw error;
				precisionErrors++;
			}
		}
		const defaultSession = createSession(await openDurableObjectSqliteStorage(this.ctx.storage));
		const defaultCount = await defaultSession.commit(async (tx) => ++(await tx.doc(Counter)).count, context);
		await defaultSession.close(context);
		const reopenedDefault = createSession(await openDurableObjectSqliteStorage(this.ctx.storage));
		const defaultRestored = (await reopenedDefault.snapshot(Counter, context)).count;
		await reopenedDefault.close(context);
		let session = createSession(await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "runtime" }));
		const count = await session.commit(async (tx) => {
			const doc = await tx.doc(Counter);
			return ++doc.count;
		}, context);
		await session.close(context);
		session = createSession(await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "runtime" }));
		const restored = (await session.snapshot(Counter, context)).count;
		await session.close(context);
		const vm = createInlineCodemodeSandbox({ tools: [{ name: "twice", execute: (args) => args * 2 }] });
		let script;
		try {
			script = await vm.execute('const x=await tools.twice(21);text(x);store("done",true);return x;');
		} finally {
			await vm.close();
		}
		const defaultVm = createInlineCodemodeSandbox();
		let defaultScript;
		try { defaultScript = await defaultVm.execute("return 41;"); } finally { await defaultVm.close(); }
		const remote = new RemoteCodemodeSandbox({
			remote: () => this.env.SANDBOX.getByName("test"),
			tools: [{ name: "twice", execute: (args) => args * 2 }],
		});
		let remoteScript;
		try {
			remoteScript = await remote.execute("return await tools.twice(21);");
		} finally {
			await remote.close();
		}
		const models = createModels(),
			faux = fauxProvider(),
			registry = createRegistry(),
			reports = [];
		models.setProvider(faux.provider);
		registry.install({
			name: "math",
			tools: [
				defineTool({
					name: "answer",
					description: "Return an answer",
					parameters: Type.Object({ value: Type.Number() }),
					execute: async (args) => ({ output: [{ type: "text", text: String(args.value) }] }),
				}),
			],
		});
		const open = async () =>
			Harness.open(
				await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "agent" }),
				{ models, registry, onReport: ({ error }) => reports.push(String(error)) },
				context,
			);
		let harness = await open();
		let agent;
		try {
			let conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("answer", { value: 42 }, { id: "a-" + count })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("done")]),
			]);
			const status = (await (await conversation.submit({ type: "input", content: "answer" }, context)).wait(context))
				.status;
			await harness.close(context);
			harness = await open();
			conversation = await harness.root(context);
			const entries = (await conversation.entries({}, 1000, undefined, context)).items;
			agent = {
				status,
				toolResults: entries.filter(ToolResultEntry.is).map((entry) => entry.model[0].content),
				reports,
			};
		} finally {
			await harness.close(context);
		}
		await db.close();
		const afterClose = await db.all("SELECT * FROM checks ORDER BY id");
		return Response.json({
			rows,
			binary,
			binaryRead: Array.from(binaryRead.bytes),
			integers,
			precisionErrors,
			defaultStorage: { count: defaultCount, restored: defaultRestored },
			defaultScript,
			afterClose,
			rejected,
			count,
			restored,
			script,
			remoteScript,
			agent,
			changedRows: [inserted, changed],
		});
	}
}
export default { fetch: (request, env) => env.STATE.get(env.STATE.idFromName("check")).fetch(request) };
