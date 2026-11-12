import { createElement, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
	createHost,
	createLanguage,
	defineFacet,
	defineMessages,
	defineRegistry,
	event,
	hostLanguage,
	int,
	local,
	method,
	str,
	type Held,
} from "../../src/index.ts";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import {
	HostProvider,
	useEvents,
	useHold,
	useMessages,
	usePageState,
	useRefState,
	useRegistry,
	useWatch,
} from "../../src/react/index.ts";
import { NO_TRANSLATIONS } from "../../src/surfaces/translations.ts";

async function run() {
	const Feed = local("browser.feed", {
		version: 1,
		params: { name: str() },
		members: { count: int(), next: event(str()), increment: method(), emit: method(str()) },
	});
	const Counts = defineRegistry<number, number>("browser.counts", { version: 1 });
	const messages = defineMessages("browser", { en: { title: "Ready" }, fr: { title: "Prêt" } });
	const failures: string[] = [],
		received: string[] = [];
	const host = createHost({
		onError: (error) =>
			failures.push(
				JSON.stringify(error, (_key, value) =>
					value instanceof Error ? { message: value.message, stack: value.stack } : value,
				),
			),
	});
	await host.load(
		[
			{
				name: "feed",
				facet: defineFacet((facet, self) => {
					facet.serve(Counts, { compose: (entries) => entries.reduce((sum, entry) => sum + entry.value, 0) });
					self.contribute(Counts, 17);
					facet.serve(Feed, (_params, self) => {
						const count = self.writable(0),
							next = self.events<string>();
						return {
							count: self.derive([count], ([value]) => value),
							next,
							async increment() {
								count.set(count.value + 1);
								return null;
							},
							async emit(value) {
								next.emit(value);
								return null;
							},
						};
					});
				}),
			},
		],
		context,
	);
	const root = createRoot(document.getElementById("app")!);
	let held: Held<typeof Feed> | undefined;
	let edit: (value: string) => void = () => {};
	function View({ name, label, pageKey }: { name: string; label: string; pageKey: string }) {
		const ref = useHold(Feed, { name });
		const state = useRefState(ref),
			count = useWatch(ref?.count),
			total = useRegistry(Counts);
		const [draft, setDraft] = usePageState(pageKey, "");
		const { t, locale } = useMessages(messages);
		useEvents(ref?.next, ({ value }) => received.push(`${label}:${value}`));
		useLayoutEffect(() => {
			if (label === "updated") void ref?.emit("layout", context);
		}, [ref, label]);
		held = ref;
		edit = setDraft;
		return createElement(
			"output",
			null,
			JSON.stringify({ status: state?.kind, count, total, draft, title: t("title"), locale }),
		);
	}
	function paint(name: string, label: string, pageKey = "draft", key = "view") {
		flushSync(() =>
			root.render(createElement(HostProvider, { host }, createElement(View, { name, label, pageKey, key }))),
		);
	}
	function snapshot() {
		return JSON.parse(document.querySelector("output")?.textContent ?? "null");
	}
	async function until(check: () => boolean) {
		for (let tries = 0; tries < 200; tries++) {
			if (check()) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(
			`Browser state did not settle: ${JSON.stringify({ view: snapshot(), failures, state: held?.state.value })}`,
		);
	}
	try {
		paint("east", "initial");
		await until(() => snapshot()?.status === "live" && snapshot()?.total === 17);
		const initial = snapshot();
		await held!.increment(context);
		await until(() => snapshot()?.count === 1);
		await held!.emit("first", context);
		await until(() => received.length === 1);
		flushSync(() => edit("unfinished input"));
		const changed = snapshot();
		paint("east", "updated");
		await until(() => received.length === 2);
		const beforeLanguage = document.querySelector("output");
		hostLanguage(host).set(createLanguage("fr", NO_TRANSLATIONS, () => {}));
		await until(() => snapshot()?.title === "Prêt");
		const translated = snapshot();
		const sameElement = beforeLanguage === document.querySelector("output");
		paint("east", "remounted", "draft", "new-component");
		await until(() => snapshot()?.status === "live");
		const restoredDraft = snapshot().draft;
		const previous = held!;
		paint("west", "replacement", "other");
		await until(() => snapshot()?.status === "live" && snapshot()?.count === 0);
		await until(() => previous.state.value.kind === "ended");
		const replacement = snapshot();
		await held!.emit("last", context);
		await until(() => received.length === 3);
		const last = held!;
		flushSync(() => root.unmount());
		await until(() => last.state.value.kind === "ended");
		let releasedCall = false;
		try {
			await last.emit("after unmount", context);
		} catch {
			releasedCall = true;
		}
		return { initial, changed, translated, sameElement, restoredDraft, replacement, received, releasedCall, failures };
	} finally {
		root.unmount();
		await host.close(context);
	}
}

void run()
	.then(
		(value) => ({ value }),
		(error) => ({ error: String(error), stack: error?.stack }),
	)
	.then((result) => {
		document.getElementById("result")!.textContent = btoa(
			String.fromCharCode(...new TextEncoder().encode(JSON.stringify(result))),
		);
	});
