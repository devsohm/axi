import { local, obj, str, unknown } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { constant } from "../../state/index.ts";
export const AppInfo = local("objects.app.info", {
	version: 2,
	params: {},
	members: { dataDir: str(), name: str(), version: str(), owner: unknown() },
});
export const WorkerInfo = local("objects.app.worker-info", {
	version: 1,
	params: {},
	members: { address: obj({ kind: str(), key: str(), params: unknown() }), start: unknown() },
});
export function appInfoFacet<P extends Principal>(info: {
	readonly dataDir: string;
	readonly name: string;
	readonly version: string;
	readonly owner: P;
}): Facet<P> {
	return defineFacet<P>((host) =>
		host.serve(AppInfo, () => ({
			dataDir: constant(info.dataDir),
			name: constant(info.name),
			version: constant(info.version),
			owner: constant(info.owner),
		})),
	);
}
export function workerInfoFacet<P extends Principal>(info: {
	readonly address: { readonly kind: string; readonly key: string; readonly params: JsonValue };
	readonly start: JsonValue;
}): Facet<P> {
	return defineFacet<P>((host) =>
		host.serve(WorkerInfo, () => ({ address: constant(info.address), start: constant(info.start) })),
	);
}
