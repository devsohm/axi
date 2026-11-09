import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Principal } from "../../data/index.ts";
import { createHost, type PrincipalAttributes } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { openNodeSqliteDatabase } from "../../sqlite/node.ts";
import { openStore, sqliteBackend } from "../../store/index.ts";
import { translationsFacet } from "../../surfaces/index.ts";
import { sendWorkerTelemetry, TelemetryRecorder } from "../../telemetry-ingest/index.ts";
import type { Watchable } from "../../watch.ts";
import { workerMain } from "../workers/child.ts";
import type { AppApi, AppKind, KitStart } from "./app.ts";
import { hostDataFacet } from "./data.ts";
import { filesFacet } from "./files.ts";
import { workerInfoFacet } from "./info.ts";
import { privateDirectory, privateStore } from "./layout.ts";
export type WorkerOptions<P extends Principal = Principal> = {
	readonly api: AppApi;
	readonly kinds: Readonly<Record<string, AppKind>>;
	readonly busy?: Watchable<Readonly<Record<string, number>>>;
	readonly principalAttributes?: PrincipalAttributes<P>;
	readonly onError: (error: unknown) => void;
};
export function startWorker<P extends Principal>(options: WorkerOptions<P>): void {
	const packages = Object.assign({}, ...Object.values(options.kinds).map((kind) => kind.packages ?? {}));
	workerMain(
		async ({ address, start, parent, plugins, onClose }, context) => {
			const { kit, app } = start as unknown as { kit: KitStart; app: JsonValue };
			await privateDirectory(kit.dir);
			const path = join(kit.dir, "store.sqlite");
			await privateStore(path);
			const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
			onClose((ctx) => store.close(ctx));
			const scope = crypto.randomUUID(),
				recorder = kit.telemetry ? new TelemetryRecorder(() => scope, 10_000) : undefined;
			const host = createHost<P>({
				address,
				principal: kit.principal as P,
				store,
				telemetry: recorder,
				principalAttributes: options.principalAttributes,
				...kit.timeouts,
				onError: options.onError,
			});
			onClose((ctx) => host.close(ctx));
			host.connect(parent, { principal: kit.server as P, trusted: true }, context);
			await plugins.load(
				host,
				{
					kind: kit.facet,
					core: [
						{
							name: "objects.app.worker-info",
							facet: workerInfoFacet<P>({
								address: { kind: address.kind, key: address.key, params: address.params as JsonValue },
								start: app,
							}),
						},
						{ name: "objects.app.files", facet: filesFacet<P>(join(kit.dir, "files"), kit.files, kit.uploads) },
						{ name: "objects.app.data", facet: hostDataFacet<P>(store, join(kit.dir, "files"), kit.server as P) },
						{ name: "objects.translations", facet: translationsFacet<P>() },
					],
				},
				context,
			);
			if (recorder) {
				const sender = sendWorkerTelemetry(host, recorder, context),
					timer = setInterval(() => void sender.send(false), 1000);
				timer.unref();
				onClose(async () => {
					clearInterval(timer);
					await Promise.race([sender.send(true), delay(1000, undefined, { ref: false })]);
					sender.stop();
				});
			}
			return options.busy ? { busy: options.busy } : {};
		},
		{
			hostPackages: { ...options.api.modules, ...packages },
			redact: () => ({ message: "worker failed" }),
			onError: options.onError,
		},
	);
}
