# Install Axi

This directory contains the Axi package archives for Node.js applications. It is not a standalone terminal application.

## Install the packages

Use Node.js 22.19 or later. The release checks use Node.js 26.10.

Extract the archive, open the extracted directory, and run:

```sh
npm install
```

The local `package.json` installs all seven Axi archives together. Axi packages do not require an npm registry release. External dependencies download from the npm registry.

To add Axi to an existing application, copy the `packages` directory into the application. Add the seven `file:./packages/...` dependencies from this release's `package.json` to the application's dependencies. Then run `npm install` in that application.

## Import a package

```js
import { createSession, MemoryStorage } from "@axi/durable";
import { BACKGROUND_CONTEXT } from "@axi/chord/context";

const session = createSession(new MemoryStorage());
try {
	const conversation = await session.commit(
		tx => tx.createConversation({ ownership: { kind: "ownerless" } }),
		BACKGROUND_CONTEXT,
	);
	console.log(conversation.id);
} finally {
	await session.close(BACKGROUND_CONTEXT);
}
```

Applications choose the models, tools, extensions, configuration, and user interface. MCP and Code Mode are independent packages. They activate only when an application installs them.

## Use native environments

`@axi/env` uses a packaged daemon for file operations, processes, and terminals. Installed native binaries do not require Rust. The SSH client must be available on the machine that opens the connection.

A local package build contains its host binary. The combined CI archive contains the Linux, macOS, Windows, and Android builds for x64 and arm64. The release workflow runs native integration checks on the six desktop targets. Android jobs compile the daemon but do not run it on a device. PTYs require a Unix remote system.

## Remove the packages

Run this command in the application that installed Axi:

```sh
npm uninstall @axi/ai @axi/chord @axi/codemode @axi/durable @axi/env @axi/mcp @axi/telemetry
```

Application-owned session files and credentials remain in place. The toolkit does not choose their location or remove them.
