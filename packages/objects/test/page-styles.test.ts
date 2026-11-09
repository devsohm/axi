import { afterEach, expect, it, vi } from "vitest";
import type { ClientError, ScriptSet } from "../src/surfaces/index.ts";
import { PageStyles } from "../src/web/styles.ts";

class Link extends EventTarget {
	rel = "stylesheet";
	media = "";
	href = "";
	getAttribute(name: string) {
		return name === "href" ? this.href : null;
	}
	removeAttribute(name: string) {
		if (name === "media") this.media = "";
	}
	remove() {
		const index = links.indexOf(this);
		if (index >= 0) links.splice(index, 1);
	}
	after(next: Link) {
		next.remove();
		links.splice(links.indexOf(this) + 1, 0, next);
	}
	before(next: Link) {
		next.remove();
		links.splice(links.indexOf(this), 0, next);
	}
}
const links: Link[] = [];
afterEach(() => {
	links.length = 0;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
function page(initial: Record<string, string> = {}, ended: Record<string, "load" | "error"> = {}) {
	vi.useFakeTimers();
	vi.stubGlobal("document", {
		querySelectorAll: () => links,
		createElement: () => new Link(),
		head: { append: (link: Link) => links.push(link) },
	});
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
		setTimeout(() => callback(Date.now()), 16),
	);
	for (const href of Object.values(initial)) {
		const link = new Link();
		link.href = href;
		links.push(link);
	}
	const errors: ClientError[] = [];
	const styles = new PageStyles(initial, ended, (error) => errors.push(error));
	const set = (sheets: Record<string, string | undefined>): ScriptSet => ({
		base: "base",
		combined: "combined",
		plugins: Object.entries(sheets).map(([name, css]) => ({ name, css, digest: "digest", url: name + ".js" })),
	});
	return { styles, errors, set };
}

it("prepares styles inactive beside their current plugin and retires old styles after the next drawn frame", async () => {
	const { styles, set } = page({ a: "a-old.css", c: "c.css" }, { "a-old.css": "load", "c.css": "load" });
	const update = set({ a: "a-new.css", b: "b.css", c: "c.css" });
	const waiting = styles.prepare(update, new AbortController().signal);
	expect(links.map((link) => [link.href, link.media])).toEqual([
		["a-old.css", ""],
		["a-new.css", "not all"],
		["b.css", "not all"],
		["c.css", ""],
	]);
	links[1]!.dispatchEvent(new Event("load"));
	links[2]!.dispatchEvent(new Event("load"));
	await waiting;
	styles.settle(update, new Set());
	expect(links.every((link) => link.media === "")).toBe(true);
	expect(links.map((link) => link.href)).toContain("a-old.css");
	await vi.advanceTimersByTimeAsync(40);
	expect(links.map((link) => link.href)).toEqual(["a-new.css", "b.css", "c.css"]);
});

it("keeps the old stylesheet when its plugin rejects the new code", async () => {
	const { styles, set } = page({ a: "old.css" }, { "old.css": "load" }),
		update = set({ a: "new.css" });
	const waiting = styles.prepare(update, new AbortController().signal);
	links[1]!.dispatchEvent(new Event("load"));
	await waiting;
	styles.settle(update, new Set(["a"]));
	await vi.advanceTimersByTimeAsync(40);
	expect(links.map((link) => [link.href, link.media])).toEqual([["old.css", ""]]);
});

it("reports failed loads and retries them even when the URL has not changed", async () => {
	const { styles, errors, set } = page({ a: "same.css" }, { "same.css": "error" }),
		update = set({ a: "same.css" });
	const waiting = styles.prepare(update, new AbortController().signal);
	links[1]!.dispatchEvent(new Event("error"));
	await waiting;
	expect(errors).toEqual([{ kind: "stylesheet_failed", plugin: "a", url: "same.css", reason: "error" }]);
	styles.settle(update, new Set());
	await vi.advanceTimersByTimeAsync(40);
	const failed = links[0];
	const retry = styles.prepare(update, new AbortController().signal);
	expect(links[1]).not.toBe(failed);
	links[1]!.dispatchEvent(new Event("load"));
	await retry;
	styles.settle(update, new Set());
	await vi.advanceTimersByTimeAsync(40);
	expect(links).toHaveLength(1);
});

it("allows late loads after a timeout and removes cancelled preparations without reporting an error", async () => {
	const { styles, errors, set } = page(),
		update = set({ a: "slow.css" });
	const waiting = styles.prepare(update, new AbortController().signal);
	await vi.advanceTimersByTimeAsync(10_000);
	await waiting;
	expect(errors).toEqual([{ kind: "stylesheet_failed", plugin: "a", url: "slow.css", reason: "timeout" }]);
	styles.settle(update, new Set());
	const active = links[0]!;
	expect(active.media).toBe("");
	active.dispatchEvent(new Event("load"));
	await styles.prepare(update, new AbortController().signal);
	expect(links).toEqual([active]);
	const abort = new AbortController(),
		cancelled = styles.prepare(set({ a: "later.css" }), abort.signal);
	const removed = links[1]!;
	abort.abort();
	await cancelled;
	removed.dispatchEvent(new Event("error"));
	expect(links).toEqual([active]);
	expect(errors).toHaveLength(1);
});
