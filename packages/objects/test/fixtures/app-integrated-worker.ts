import * as objects from "../../src/index.ts";
import { Files, startWorker, WorkerInfo } from "../../src/node/app/index.ts";

startWorker({
	api: { name: "@example/api", versions: ["v1"], modules: { "@example/api/v1": { ...objects, Files, WorkerInfo } } },
	kinds: { server: { platform: "node" }, worker: { platform: "node" } },
	principalAttributes: (principal) => ({ "app.identity": principal.kind }),
	onError: (error) => console.error(error),
});
