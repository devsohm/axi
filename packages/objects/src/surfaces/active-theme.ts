import { withAbortSignal, type Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { ThemeChoice } from "./theme-choice.ts";
import { activeTheme, Themes, type Theme, type ThemePick } from "./themes.ts";
export type ThemeFollower = { setMode(mode: Theme["mode"]): void; stop(): void };
export async function followActiveTheme<P extends Principal>(
	host: Host<P>,
	mode: Theme["mode"],
	changed: (theme: Theme) => void,
	context: Context,
): Promise<ThemeFollower> {
	const controller = new AbortController(),
		ctx = withAbortSignal(controller.signal, context);
	let themes: readonly Theme[] = [],
		pick: ThemePick = { dark: null, light: null },
		current = mode;
	const update = (): void => changed(activeTheme(themes, pick, current));
	update();
	const registry = await host.registry(Themes, ctx);
	themes = registry.value;
	update();
	(await registry.watch(ctx)).start(async (frame) => {
		if (frame.kind === "value") themes = frame.value;
		update();
	});
	const choice = host.hold(ThemeChoice, {}, ctx);
	void choice.pick.watch(ctx).then(
		(feed) =>
			feed.start(async (frame) => {
				if (frame.kind === "value") pick = frame.value;
				update();
			}),
		() => {},
	);
	return {
		setMode(next) {
			current = next;
			update();
		},
		stop() {
			controller.abort();
			choice.release();
		},
	};
}
