# Clients

Objects can run a client host in a browser or a terminal sandbox. The host keeps references connected, watches published plugin scripts and replaces changed facets while it runs. A failed replacement keeps the previous working facet. A failed script download reports `update_failed` and retries after one second. The delay doubles up to 30 seconds. Updates run in order; a new script set replaces the pending retry. Stopping the client cancels retries.

Connection retries start after 250 milliseconds and double to a five-second limit. Ten seconds of stable connection resets that delay. `canRetry` and the server-base check run beside the next attempt, so a slow check cannot delay reconnecting. One pending check covers later closes. A refusal closes the current attempt and reports `waiting`. A changed server base closes that attempt before calling `outdated`. Waking retries a scheduled attempt immediately; a close soon after waking also receives one immediate retry before ordinary backoff resumes.

## Browser clients

Use `webSurface` from `@axi/objects/surfaces` on the server. Give it a browser entry file, the plugin component and a page template. Add the returned facet to the server's core facets. Use its rollout step after the server step when publishing plugin changes.

`webSurface(host, options)` and `tuiSurface(host, options)` return synchronously. Load their facets before calling `build()`. The first request or rollout can also start the build. All callers share that work. Until it finishes, `built` is undefined; it then contains either the base hash and source inputs or a failure. Routes that need a failed bundle return HTTP 503. Cancelling a rollout wait leaves the shared build running.

The template receives a nonce and `PageAssets`. Call `pageScripts(assets, nonce)` to include the bootstrap, styles and scripts in the required order. The bundle and plugin URLs contain content hashes. Routes require authentication unless `public: true` is set.

Call `startPage` from `@axi/objects/web` in the browser entry. Supply the server's WebSocket connection, the modules plugins can import and a render callback. A new plugin script reloads its facet in place. A changed base bundle reloads the page.

The client starts from its bundled plugins while the server is unavailable. Once the script watch connects, it applies the current snapshot before following later updates. `stop()` cancels a pending watch as well as retries.

Set `themes: false` on `startPage` when the application owns its CSS variables. This skips the built-in theme facet and theme subscription. Translations, language selection and rendering still run. Set `follow: false` on `startPage` or `startClient` for a static client. It keeps its bundled plugins and reconnects normally, without following script sets or checking the server's base hash. These two options are independent.

Use `webSurface(host, { plugins, entry, routes: false })` when the application supplies its own HTTP routes. Load its facet as usual to publish `WebScripts`. The surface then contributes no HTTP routes or content security policy. Call `file(path)`, `pageAssets()` and `base()` from application routes to read its generated files, page metadata and base hash. A failed build returns HTTP 503 from `file()` and undefined from the other two methods. Normal route mode requires a `page` template.

For a page built separately from its server, `@axi/objects/surfaces` exports `buildBase(entry, platform, prefix, resolution)` and `pageBootstrap(base, scriptSet)`. `resolution` is a `BaseResolution` object with optional `conditions` and `tsconfig` fields. The base builder collects referenced images, fonts and WebAssembly files under content-named asset URLs. Its input map records their hashes along with source files. Serve every generated file and put the bootstrap before plugin scripts and the base script. A separately deployed page can use `follow: false` to retain that build.

Set `tsconfig` on `webSurface` or `tuiSurface` when the server resolves workspace imports through that file's `paths` mappings. The base then uses those mappings even when dependency packages have no built files. Without `tsconfig`, base builds ignore tsconfig files. `conditions` defaults to the server process's resolution conditions.

An update fetches new plugin stylesheets with `media="not all"` before reloading code. It waits for each load, error or ten-second timeout. Styles remain in plugin order. Accepted code activates its prepared stylesheet. A plugin that keeps its old code also keeps its old stylesheet. Replaced styles leave after the page draws a frame.

`stylesheet_failed` reports a failed or timed-out stylesheet without preventing the code update. A later load can still apply after a timeout. A failed load is retried with the next update, even at the same URL. Stopping the client cancels waits and removes prepared styles. A reconnect retries scripts that previously failed to load or evaluate.

UI contributed by an object can briefly lose its old styling while that object restarts. The old stylesheet leaves after the reload, but the object's old UI remains until its successor becomes live. UI contributed directly by a facet changes with that facet's stylesheet. Reloaded components acquire fresh references and can show their loading state for a round trip.

For a custom client, `ClientOptions.styles` accepts `ClientStyles`: `prepare(set, signal)` fetches inactive styles before reload, and `settle(set, kept)` activates styles for accepted plugins. `kept` identifies plugins retaining their old code. `pageScripts` puts the bootstrap before stylesheets so it can record load failures that occur before `startPage` runs.

## React

The optional `@axi/objects/react` entry requires React. Wrap components in `HostProvider`. `useHold` acquires and releases a reference with the component. `useWatch`, `useRegistry` and `useRefState` follow values. `usePageState` retains local values across component remounts on the same host.

`useEvents(member, listener)` subscribes while the component is mounted and that member remains selected. Delivery calls the latest committed listener without resubscribing on each render. An undefined member leaves no subscription. Switching the member or unmounting cancels the old subscription. Events do not request a render themselves.

## Terminal clients

The `@axi/objects/tui` entry is independent of the terminal rendering library. `TuiScope` holds references, follows values and requests redraws. Dispose a scope when its component ends. Host page state survives replacement of the scope.

`scope.on(member, listener)` listens until the scope is disposed. The listener decides whether to redraw; events do not call the scope's redraw callback automatically.

`scope.optimistic(read, reduce?)` returns a reader, `add(action, call)` and a `pending()` reader. The reducer applies actions in order over the current server value. Without a reducer, the latest action is the displayed value. Actions remain until every added call settles, including rejected calls. The reader then uses the server value again. `add` returns the original promise; callers handle rejections. Disposing the scope stops its redraws.

`startTerminalRuntime` runs inside a launcher-provided sandbox. `BridgeTerminal` receives input and size changes and sends drawing frames. Machine actions such as copying text, opening a URL or attaching a file pass through the launcher's request bridge.

The sandbox cannot use this bridge as direct filesystem or network access. The trusted launcher controls credentials and machine actions. Its output filter permits drawing controls and drops clipboard, title and other terminal configuration escapes.

### Trusted Node launcher

Call `startTerminal` from `@axi/objects/tui/launcher` with the server URL and credentials. Credentials can be a token, a token file or an owner-approved pairing flow. The launcher retains the token outside the sandbox and authenticates downloads and connections itself.

This launcher requires Node 26.5.1 or later. It starts a separate process with Node permissions, a bounded heap, no inherited credentials and a restricted builtin-module interface. The sandbox receives terminal size, input, language choices and drawing access through its bridge. The portable `@axi/objects/tui` runtime does not itself require this Node launcher.

Copying text, opening a browser URL and reading an attachment require confirmation. A symlink attachment also shows the resolved file for approval. Attachment reads check the opened file's identity and size. Browser actions accept HTTP and HTTPS URLs without user information.

The launcher limits frames, bundle downloads, simultaneous requests and sockets. It filters client output before writing to the terminal. Three Ctrl+C presses within one second exit the launcher. Exit restores terminal modes and removes its input and resize listeners. Call the returned `stop()` when the application owns the launcher's lifetime.

## Messages and preferences

`defineMessages` creates a typed message catalog. A message may be a string or a function with typed parameters. `t.message` produces message data for remote state. `t.render` renders that data in the client's language.

Plugins contribute translations through `Translations` and themes through `Themes`. The client follows the user's persisted `LocaleChoice` and `ThemeChoice`. Browser clients update document language, direction and CSS variables. Terminal clients read colors through `TerminalTheme`.

Choices are stored per principal in the server's Objects store. Page state is local to a client host and is collected with that host. It is not a persisted server document.
