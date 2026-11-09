declare module "cloudflare:workers" {
	export abstract class DurableObject<Env = unknown> {
		protected ctx: unknown;
		protected env: Env;
		constructor(ctx: unknown, env: Env);
	}
}
declare module "*/quickjs.wasm" {
	const module: unknown;
	export default module;
}
