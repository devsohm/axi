import { googleVertexApi } from "../api/google-vertex.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_VERTEX_MODELS } from "./google-vertex.models.ts";

const auth: ApiKeyAuth = {
	name: "Google Cloud credentials",
	async login(interaction) {
		interaction.signal.throwIfAborted();
		const method = await interaction.prompt({
			type: "select",
			message: "Select Google Vertex AI authentication method:",
			options: [
				{ id: "api-key", label: "Google Cloud API key" },
				{ id: "adc", label: "Application Default Credentials" },
				{ id: "service-account", label: "Service account credentials file" },
			],
		});
		interaction.signal.throwIfAborted();
		if (method === "api-key")
			return {
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter Google Cloud API key" }),
			};
		if (method !== "adc" && method !== "service-account")
			throw new Error(`Unknown Google Vertex AI auth method: ${method}`);
		interaction.notify({
			type: "info",
			message:
				method === "adc"
					? "Run `gcloud auth application-default login`, then provide the project and location."
					: "Provide a service account credentials file, project, and location.",
			links: [
				{
					label: "Application Default Credentials",
					url: "https://cloud.google.com/docs/authentication/provide-credentials-adc",
				},
			],
		});
		const project = await interaction.prompt({ type: "text", message: "Enter Google Cloud project ID" });
		const location = await interaction.prompt({ type: "text", message: "Enter Google Cloud location" });
		const path =
			method === "service-account"
				? await interaction.prompt({ type: "text", message: "Enter service account credentials file path" })
				: undefined;
		return {
			type: "api_key",
			env: {
				GOOGLE_CLOUD_PROJECT: project,
				GOOGLE_CLOUD_LOCATION: location,
				...(path ? { GOOGLE_APPLICATION_CREDENTIALS: path } : {}),
			},
		};
	},
	async resolve({ ctx, credential, signal }) {
		const read = async (name: string) => {
			signal.throwIfAborted();
			const value = await ctx.env(name);
			signal.throwIfAborted();
			return value;
		};
		const key = credential?.key ?? (await read("GOOGLE_CLOUD_API_KEY"));
		if (key) return { auth: { apiKey: key }, source: credential?.key ? "stored credential" : "GOOGLE_CLOUD_API_KEY" };
		const path = credential?.env?.GOOGLE_APPLICATION_CREDENTIALS ?? (await read("GOOGLE_APPLICATION_CREDENTIALS"));
		signal.throwIfAborted();
		const exists = await ctx.fileExists(path ?? "~/.config/gcloud/application_default_credentials.json");
		signal.throwIfAborted();
		const project =
			credential?.env?.GOOGLE_CLOUD_PROJECT ?? (await read("GOOGLE_CLOUD_PROJECT")) ?? (await read("GCLOUD_PROJECT"));
		const location = credential?.env?.GOOGLE_CLOUD_LOCATION ?? (await read("GOOGLE_CLOUD_LOCATION"));
		return exists && project && location
			? {
					auth: {},
					env: credential?.env,
					source: credential ? "stored credential" : "gcloud application default credentials",
				}
			: undefined;
	},
};
export function googleVertexProvider(): Provider<"google-vertex"> {
	return createProvider({
		id: "google-vertex",
		name: "Google Vertex AI",
		models: Object.values(GOOGLE_VERTEX_MODELS),
		api: googleVertexApi(),
		auth: { apiKey: auth },
	});
}
