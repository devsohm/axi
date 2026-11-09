import { BACKGROUND_CONTEXT } from "../../context/index.ts";
import { method, obj, remote, str, type Address } from "../../contracts/index.ts";
import { forbidden, type Principal } from "../../data/index.ts";
import { samePrincipal } from "../../data/principal.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { Store } from "../../store/index.ts";
import { packStore, type ArchiveManifest } from "./archive.ts";
export const HostData = remote("objects.app.data", {
	version: 1,
	params: { address: str() },
	hostAddress: ({ address }) => JSON.parse(address) as Address,
	variants: { main: { methods: { exportTo: method(obj({ path: str(), manifest: str() })) } } },
});
export function addressParam(address: Address): string {
	return JSON.stringify({ kind: address.kind, params: address.params, key: address.key });
}
export function hostDataFacet<P extends Principal>(store: Store, files: string, server: P): Facet<P> {
	return defineFacet<P>((host) =>
		host.serve(HostData, (_params, principal) => {
			if (!samePrincipal(principal, server, BACKGROUND_CONTEXT))
				throw forbidden("objects.app.data: the server's only");
			return {
				variant: "main",
				members: {
					exportTo: async ({ path, manifest }, context) => {
						await packStore(store, files, JSON.parse(manifest) as ArchiveManifest, path, context);
						return null;
					},
				},
			};
		}),
	);
}
