import { bedrockConverseStreamApi } from "../api/bedrock-converse-stream.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { AMAZON_BEDROCK_MODELS } from "./amazon-bedrock.models.ts";

const auth: ApiKeyAuth = {
	name: "AWS credentials or bearer token",
	async login(interaction) {
		interaction.signal.throwIfAborted();
		const method = await interaction.prompt({
			type: "select",
			message: "Select Amazon Bedrock authentication method:",
			options: [
				{ id: "bearer-token", label: "Bearer token" },
				{ id: "aws-profile", label: "AWS profile" },
				{ id: "credential-chain", label: "Existing AWS credential chain" },
			],
		});
		interaction.signal.throwIfAborted();
		if (method === "bearer-token")
			return {
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter Amazon Bedrock bearer token" }),
			};
		interaction.notify({
			type: "info",
			message: "Amazon Bedrock supports AWS profiles, IAM credentials, and role-based credentials.",
			links: [
				{
					label: "AWS credential provider chain",
					url: "https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html",
				},
			],
		});
		if (method === "aws-profile")
			return {
				type: "api_key",
				env: { AWS_PROFILE: await interaction.prompt({ type: "text", message: "Enter AWS profile name" }) },
			};
		if (method !== "credential-chain") throw new Error(`Unknown Amazon Bedrock auth method: ${method}`);
		await interaction.prompt({ type: "text", message: "Configure AWS credentials, then press Enter to continue" });
		return { type: "api_key" };
	},
	async resolve({ ctx, credential, signal }) {
		const read = async (name: string) => {
			signal.throwIfAborted();
			const value = await ctx.env(name);
			signal.throwIfAborted();
			return value;
		};
		if (credential?.key) return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
		if (await read("AWS_BEARER_TOKEN_BEDROCK")) return { auth: {}, source: "AWS_BEARER_TOKEN_BEDROCK" };
		if (credential?.env?.AWS_PROFILE ?? (await read("AWS_PROFILE")))
			return {
				auth: {},
				env: credential?.env,
				source: credential?.env?.AWS_PROFILE ? "stored credential" : "AWS_PROFILE",
			};
		if ((await read("AWS_ACCESS_KEY_ID")) && (await read("AWS_SECRET_ACCESS_KEY")))
			return { auth: {}, source: "AWS access keys" };
		for (const [name, source] of [
			["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "ECS task role"],
			["AWS_CONTAINER_CREDENTIALS_FULL_URI", "ECS task role"],
			["AWS_WEB_IDENTITY_TOKEN_FILE", "web identity token"],
		]) {
			if (await read(name)) return { auth: {}, source };
		}
		return undefined;
	},
};
export function amazonBedrockProvider(): Provider<"bedrock-converse-stream"> {
	return createProvider({
		id: "amazon-bedrock",
		name: "Amazon Bedrock",
		models: Object.values(AMAZON_BEDROCK_MODELS),
		api: bedrockConverseStreamApi(),
		auth: { apiKey: auth },
	});
}
