import type { ClassifierFunction } from "../types.ts";
import { isRecord } from "./classifier-shared.ts";
import { classifySystemOne, type SystemOneTransport } from "./system-one-shared.ts";
const label = "Cloudflare Workers AI";
const transport: SystemOneTransport = {
	api: "cloudflare-workers-ai-system-one",
	label,
	detectCompat: (model) => ({
		imageInput: model.id.startsWith("@cf/cloudflare/clef") ? "images" : "assets",
		sendImageOptInHeader: false,
	}),
	url: (model) => new URL("run", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({ model: model.id, input: request }),
	output: (body) => {
		if (!isRecord(body)) throw new Error(`${label} returned an unexpected response`);
		if (body.success === false) {
			const errors = Array.isArray(body.errors)
				? body.errors
						.filter(isRecord)
						.map((entry) => entry.message)
						.filter((value): value is string => typeof value === "string")
				: [];
			throw new Error(errors.length ? `${label} error: ${errors.join("; ")}` : `${label} request failed`);
		}
		const result = body.result;
		if (!isRecord(result)) throw new Error(`${label} returned an unexpected response`);
		if ("answers" in result) return result;
		if (result.state !== "Completed") throw new Error(`${label} run did not complete (state: ${String(result.state)})`);
		if (!isRecord(result.result)) throw new Error(`${label} returned an unexpected response`);
		return result.result;
	},
};
export const classify: ClassifierFunction = (model, context, options) =>
	classifySystemOne(transport, model, context, options);
