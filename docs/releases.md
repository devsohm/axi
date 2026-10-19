# Build release archives

The repository distributes package archives through GitHub. The workflow does not publish to npm.

## Build on the current platform

Use Node.js 26.10 and Rust 1.98.1 for the release checks. Run these commands from the repository root:

```sh
npm ci
npm run build
npm run build:daemon --workspace @axi/env
npm run check
npm test
cargo test --locked --manifest-path packages/env/daemon/Cargo.toml
npm run pack -- release/package
npm run verify:packages -- release/package
npm ci --prefix test/workers --ignore-scripts
npm run test:workers
```

The output directory must be empty. Packing validates package versions, internal dependency versions, compiled files, native binary presence, package contents, and license files. It writes seven tarballs, a local-file dependency manifest, installation instructions, and `SHA256SUMS`.

The verification command installs the actual archives in a temporary application. It compares installed files with the build and runs a durable conversation with SQLite, native file tools, Code Mode, an explicit MCP bridge, committed views, and image processing. The temporary application is removed afterward.

The Workers test has isolated development dependencies. It runs the compiled packages in the local Workers runtime. It checks real Durable Object SQLite transactions, session reopen, a conversation with a tool call, and both inline and remote Code Mode. It does not contact a model provider or deploy a Worker.

## Build all native targets

The GitHub workflow runs the desktop builds on Linux, macOS, and Windows hosts for both architectures. It checks the installed archives on each host. Separate jobs cross-compile the two Android targets with the Android NDK. These jobs do not provide Android device acceptance.

The archive job waits for every target. It collects all eight binaries into the Env package, checks the combined archives on Linux, and uploads `axi-toolkit-VERSION.tar.gz` with its checksum.

For a manual cross-build, install the required Rust target and linker. Set `CARGO_BUILD_TARGET` to its Rust target triple before running `npm run build:daemon --workspace @axi/env`. Android requires an NDK linker selected through Cargo's target-specific linker variable.

## Prepare a release

Keep the root package version, every workspace version, internal Axi dependencies, and the Env Cargo version aligned. Update both lockfiles. Run the full checks before creating a tag.

A `vVERSION` tag must match the package version. Successful tagged runs create a draft GitHub release. Publishing that draft remains a separate action. The workflow requires repository permissions to create the draft.
