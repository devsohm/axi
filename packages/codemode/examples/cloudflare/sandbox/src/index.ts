export { CodemodeSandboxDurableObject as Sandbox } from "@axi/codemode/cloudflare";

export default {
	fetch: () => new Response("Not found", { status: 404 }),
};
