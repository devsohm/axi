/// <reference lib="dom" />
import type { Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { followActiveTheme, themeVariables } from "../surfaces/index.ts";
export async function followThemes<P extends Principal>(host: Host<P>, context: Context): Promise<() => void> {
	const media = matchMedia("(prefers-color-scheme: dark)");
	let previous = new Set<string>();
	const follower = await followActiveTheme(
		host,
		media.matches ? "dark" : "light",
		(theme) => {
			const variables = themeVariables(theme),
				style = document.documentElement.style;
			for (const name of previous) if (!Object.hasOwn(variables, name)) style.removeProperty(name);
			for (const [name, value] of Object.entries(variables)) style.setProperty(name, value);
			previous = new Set(Object.keys(variables));
			style.colorScheme = theme.mode;
		},
		context,
	);
	const update = (): void => follower.setMode(media.matches ? "dark" : "light");
	media.addEventListener("change", update);
	return () => {
		follower.stop();
		media.removeEventListener("change", update);
	};
}
