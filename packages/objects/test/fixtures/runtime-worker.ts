import * as objects from "../../src/index.ts";
import { workerMain } from "../../src/node/workers/index.ts";
import { Control } from "./worker-contracts.ts";

workerMain(
	async ({ address, parent, start, plugins, onClose }, context) => {
		const host = objects.createHost({ address, principal: { kind: "worker" }, onError() {} });
		onClose((closing) => host.close(closing));
		host.connect(parent, { principal: { kind: "server" }, trusted: true }, context);
		const facet = objects.defineFacet((h) =>
			h.serve(Control, () => ({
				variant: "active",
				members: {
					label: objects.constant(typeof start === "string" ? start : "ready"),
					echo: async (text) => text,
					crash: async () => {
						setTimeout(() => process.exit(3), 5);
						return null;
					},
				},
			})),
		);
		await plugins.load(host, { kind: "worker", core: [{ name: "runtime", facet }] }, context);
		process.stdout.write("worker ready\n");
		return undefined;
	},
	{ hostPackages: { "@axi/objects": objects }, redact: () => ({ message: "worker failed" }), onError() {} },
);
