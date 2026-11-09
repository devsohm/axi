/// <reference lib="dom" />
import type { Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { followActiveLanguage, type MessagesReport } from "../surfaces/index.ts";
export async function followLanguage<P extends Principal>(
	host: Host<P>,
	report: (report: MessagesReport) => void,
	context: Context,
): Promise<() => void> {
	const follower = await followActiveLanguage(
		host,
		navigator.languages,
		({ locale, dir }) => {
			document.documentElement.lang = locale;
			document.documentElement.dir = dir;
		},
		report,
		context,
	);
	const update = (): void => follower.setDevice(navigator.languages);
	addEventListener("languagechange", update);
	return () => {
		follower.stop();
		removeEventListener("languagechange", update);
	};
}
