# Clients

Objects can run a client host in a browser or a terminal sandbox. The host keeps references connected, watches published plugin scripts and replaces changed facets while it runs. A failed replacement keeps the previous working facet.

## Browser clients

Use `webSurface` from `@axi/objects/surfaces` on the server. Give it a browser entry file, the plugin component and a page template. Add the returned facet to the server's core facets. Use its rollout step after the server step when publishing plugin changes.

The template receives a nonce and `PageAssets`. Call `pageScripts(assets, nonce)` to include the bootstrap, styles and scripts in the required order. The bundle and plugin URLs contain content hashes. Routes require authentication unless `public: true` is set.

Call `startPage` from `@axi/objects/web` in the browser entry. Supply the server's WebSocket connection, the modules plugins can import and a render callback. A new plugin script reloads its facet in place. A changed base bundle reloads the page.

## React

The optional `@axi/objects/react` entry requires React. Wrap components in `HostProvider`. `useHold` acquires and releases a reference with the component. `useWatch`, `useRegistry` and `useRefState` follow values. `usePageState` retains local values across component remounts on the same host.

## Terminal clients

The `@axi/objects/tui` entry is independent of the terminal rendering library. `TuiScope` holds references, follows values and requests redraws. Dispose a scope when its component ends. Host page state survives replacement of the scope.

`startTerminalRuntime` runs inside a launcher-provided sandbox. `BridgeTerminal` receives input and size changes and sends drawing frames. Machine actions such as copying text, opening a URL or attaching a file pass through the launcher's request bridge.

The sandbox cannot use this bridge as direct filesystem or network access. The trusted launcher controls credentials and machine actions. Its output filter permits drawing controls and drops clipboard, title and other terminal configuration escapes.

## Messages and preferences

`defineMessages` creates a typed message catalog. A message may be a string or a function with typed parameters. `t.message` produces message data for remote state. `t.render` renders that data in the client's language.

Plugins contribute translations through `Translations` and themes through `Themes`. The client follows the user's persisted `LocaleChoice` and `ThemeChoice`. Browser clients update document language, direction and CSS variables. Terminal clients read colors through `TerminalTheme`.

Choices are stored per principal in the server's Objects store. Page state is local to a client host and is collected with that host. It is not a persisted server document.
