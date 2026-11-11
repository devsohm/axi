import * as objects from "../../src/index.ts";
import { Files, startWorker } from "../../src/node/app/index.ts";

startWorker({
	api: { name: "@example/api", versions: ["v1"], modules: { "@example/api/v1": { ...objects, Files } } },
	kinds: { server: { platform: "node" }, worker: { platform: "node" } },
	onError: (error) => console.error(error),
});
