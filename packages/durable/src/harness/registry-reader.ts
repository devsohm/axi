import type { Context } from "@axi/objects/context";
import type { RegistryValue } from "@axi/objects";
import type { RegistryReader, RegistrySnapshot, ToolRegistration } from "./types.ts";

export function registryReader<T extends ToolRegistration = ToolRegistration>(
	value: RegistryValue<RegistrySnapshot<T>>,
	context: Context,
): RegistryReader<T> {
	return {
		snapshot() {
			return value.value;
		},
		subscribe(listener) {
			const observation = value.observe(
				{
					advance(call) {
						if (call.kind === "value") listener();
					},
					end() {},
				},
				context,
			);
			return () => observation.detach();
		},
	};
}
