import type { ClassifierFunction } from "../types.ts";
import { isRecord } from "./classifier-shared.ts";
import { classifySystemOne, type SystemOneTransport } from "./system-one-shared.ts";
const transport: SystemOneTransport = {
	api: "typesafe-system-one",
	label: "System One API",
	detectCompat: (model) => ({
		imageInput:
			model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "state-image-urls" : "assets",
		sendImageOptInHeader: model.provider !== "openrouter" && !model.baseUrl.includes("openrouter.ai"),
	}),
	url: (model) => new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({ model: model.id, ...request }),
	output: (value) => {
		if (!isRecord(value)) throw new Error("System One API returned an unexpected response");
		return value;
	},
};
export const classify: ClassifierFunction = (model, context, options) =>
	classifySystemOne(transport, model, context, options);
