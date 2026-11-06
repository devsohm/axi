import type { Context } from "../../context/index.ts";
import type { FollowAttachment, FollowObserver } from "../../host/index.ts";
import type { FolderEntry } from "./files-index.ts";

export type FolderListing = { readonly entries: FolderEntry[]; readonly more: boolean };
export type ListingReader = (space: string, folder: string, context: Context) => Promise<FolderListing>;
type Subscription = {
	space: string;
	folder: string;
	observer: FollowObserver<unknown>;
	revision: number;
	ready: boolean;
};

export class FolderViews {
	#reader!: ListingReader;
	readonly #subscriptions = new Set<Subscription>();
	bind(reader: ListingReader): void {
		this.#reader = reader;
	}
	async attach(
		space: string,
		folder: string,
		observer: FollowObserver<unknown>,
		context: Context,
	): Promise<FollowAttachment<FolderListing>> {
		const subscription: Subscription = { space, folder, observer, revision: 0, ready: false };
		this.#subscriptions.add(subscription);
		try {
			for (;;) {
				const revision = subscription.revision;
				const value = await this.#reader(space, folder, context);
				if (revision !== subscription.revision) continue;
				subscription.ready = true;
				return { value, detach: () => this.#subscriptions.delete(subscription) };
			}
		} catch (error) {
			this.#subscriptions.delete(subscription);
			throw error;
		}
	}
	async changed(space: string, context: Context): Promise<void> {
		const folders = new Map<string, Subscription[]>();
		for (const item of this.#subscriptions) {
			if (item.space !== space) continue;
			if (!item.ready) {
				item.revision++;
				continue;
			}
			const group = folders.get(item.folder) ?? [];
			group.push(item);
			folders.set(item.folder, group);
		}
		for (const [folder, subscribers] of folders) {
			const value = await this.#reader(space, folder, context);
			for (const item of subscribers)
				if (this.#subscriptions.has(item))
					item.observer.advance({ kind: "value", value, ops: [["r", value]], retired: false }, context);
		}
	}
}
