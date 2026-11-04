export function normalizeMcpInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const normalized = { ...schema, type: schema.type ?? "object" };
	return schema.properties === undefined ? { ...normalized, properties: {} } : normalized;
}
