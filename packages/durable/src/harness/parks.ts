import type { ToolExecutionApi, ToolExecutionResult, ToolPark, ToolRegistration } from "./types.ts";

export const parkOrigins = Symbol("axi.tool.parkOrigins");
export type ParkCarrier = { readonly [parkOrigins]?: WeakSet<ToolPark> };
const wrappedTools = new WeakSet<ToolRegistration>();

export function isToolPark(value: ToolExecutionResult | ToolPark): value is ToolPark {
	return "sleep" in value || "wait" in value;
}

export function invalidPark(tool: ToolRegistration, value: ToolPark, api: ParkCarrier): string | undefined {
	if ("sleep" in value && "wait" in value) return "a park has either sleep or wait, not both";
	for (const key of ["output", "structuredOutput", "isError", "details", "diagnostics", "usage", "control"])
		if (key in value) return `a park has no result field, but this one has ${key}`;
	if (wrappedTools.has(tool) && !api[parkOrigins]?.has(value))
		return "a wrapper returned a park its base did not return";
	return undefined;
}

export function wrapExecution<T extends ToolRegistration>(tool: T, wrap: (base: T) => T): T {
	// The symbol survives an API spread, and records parks separately for each invocation.
	const base: T = wrappedTools.has(tool)
		? tool
		: {
				...tool,
				async execute(args, api: ToolExecutionApi & ParkCarrier, context) {
					const value = await tool.execute(args, api, context);
					if (isToolPark(value)) api[parkOrigins]?.add(value);
					return value;
				},
			};
	const composite = wrap(base);
	wrappedTools.add(composite);
	return composite;
}
