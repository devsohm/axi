# Node plugins

`@axi/objects/plugins` manages plugin directories. It requires Node and the optional `esbuild` peer dependency. The portable host accepts facets through `load()` and `reload()` without importing this component.

## Plugin directories

A plugin directory contains a `package.json` with a valid package name. A root can also contain single-file plugins. The `objects.plugins` manifest setting selects plugin paths and exclusion globs. Each configured facet kind has at most one file with a `.ts`, `.tsx`, `.js`, or `.mjs` extension. A directory without facet files can hold shared contracts.

`discoverPlugins(roots, { kinds }, context)` reads configured roots and manifest-selected paths. A root can be a path or `{ path, required }`. It follows linked plugin directories to their real paths. The first root wins duplicate names. Invalid directories and duplicates appear in `problems`. Missing optional roots are empty. A required root failure stops startup.

The manifest's `dependencies` are bundled. Its `objects.external` list names packages kept external in Node builds. Host packages are supplied by the application and remain external.

## Builds and evaluation

`buildFacet(plugin, kind, options, context)` returns a script or a failed result. It writes no output files. A successful build contains the source, digest, hashed inputs, copied files, and optional browser styles and assets. The digest is stable across checkout paths.

A facet can import its own files, declared dependencies, host packages, and permitted shared files of other discovered plugins. Import another plugin's files by its package name, such as `@app/notes/contracts`. A relative path into another plugin is refused. A copied file can import only host packages and files within its own plugin. A path outside these directories is refused. Node builtins and external packages are refused in browser builds. CSS and assets are available only in browser builds.

Plugin scripts have no `import.meta`, `__dirname`, `__filename`, literal dynamic imports, or top-level `await`. `pluginFile(path)` resolves a file inside the evaluated plugin's directory and refuses a path outside that directory.

`evaluateFacet(script, { plugin, hostPackages })` evaluates the script in the current Node process. Its default export must be a facet. Host packages keep their host instances. Node builtins and manifest externals resolve from the plugin's directory. Facets are trusted code, without a sandbox.

`mapStack(error)` maps registered script positions back to plugin files and lines. It does not change the raw error stack or install a global stack hook. A source map stays registered while a facet evaluation or its evaluation error remains alive.

## Component lifecycle

`createPlugins(options, context)` creates the watcher and a plugin runtime. Discovery starts at the first build or load. `options.kinds` maps each facet kind to `{ platform, hostPackages }`. The platform is `node` or `browser`; `hostPackages` lists import specifiers kept external in that kind's builds.

`load(host, { kind, core, modules }, context)` loads core facets and the current scripts for that host kind. `modules` supplies this process's actual module instances for the external host specifiers. Build and evaluation failures are omitted and returned beside the host's failures.

`build(names, context)` builds every facet of the named plugins and newly discovered plugins. It returns plain data containing facets, plugin metadata, and removed names. A structured clone can be sent to another host for reload.

`scripts(kind, context)` returns that kind's complete current script set, building it on first use. `current(kind)` reads an initialized set synchronously. A build alone does not change the set. A reload or rollout ships the build into the kinds it reaches.

`reload(host, built, context)` runs after that host's earlier reload. Unchanged digests retain their exact facet objects. Failed updates retain their loaded facets and participate in the host's dependency checks. Cancellation after commit adopts the committed set before rejecting, so a later reload does not restore stale code.

`step(name, host)` creates a local rollout step. A step has a name, its facet kinds, and a `reload` method returning one result per host. Each result contains a reload report, a clean-stop marker, or an error. `rollout(steps, built, context)` runs steps in order and stops at a rejected step. A plugin or host failure alone does not stop it. Dirty marks clear only for plugins applied to every relevant host, with every built kind shipped and no newer edit. A cloned build carries no local mark snapshot and clears no marks.

`installDependencies(name, context)` runs npm in that plugin's directory with production dependencies, without lifecycle scripts. `install.npmCommand` can replace the command. A successful install clears its install mark and marks the plugin dirty. Cancellation stops the command.

`close()` closes filesystem watchers. The application owns each host and closes those hosts separately.

## Load prebuilt scripts

The separate `runtime.ts` module has no esbuild or filesystem-watcher dependency. `createPluginRuntime()` disables V8's compilation cache once per process. Its `load(host, { kind, core, scripts, modules }, context)` evaluates a complete set of prebuilt scripts. `reload(host, scripts, context)` serializes complete-set updates for that host. Failed updates keep the previous working facet; an omitted plugin is removed. The runtime retains a committed reload even if cancellation is reported afterward.

The worker component uses this runtime to evaluate scripts built by its parent process. Workers do not rebuild plugins.

## Watch state

`state` is a JSON watchable with `dirty`, `install`, `set`, and `base` fields. The watcher marks changes and never applies code automatically.

- `dirty` lists plugins affected by changed files, including consumers of copied files.
- `install` lists plugins whose manifest changed.
- `set` requests discovery after a plugin directory or facet file changes.
- `base` reports a change in application code that requires the application's restart policy.

`base` compares file contents with the running build. `watchBase(inputs)` adds a `BaseInputs` map from absolute paths to SHA-256 hashes of the bytes the build read. Worker and client bundles expose this map as `inputs`. The watcher checks the map immediately and after file events. An edit followed by a revert clears the flag. A file recorded with different contents by two running bundles stays marked. New source files in `base` directories also set the flag. Files under `node_modules` are excluded.

This content comparison applies to `base`. Plugin `dirty` marks remain set until an applicable rollout clears them, including edits that restore the earlier bytes.

Each mark has a monotonically increasing generation. An old build cannot clear a newer edit. Watchers skip `node_modules` and `.git`, add watches for new directories, and watch linked plugin directories separately. A watch failure is reported once. The application can still build on demand.

## Test one plugin

`testPlugin()` uses the production builder and evaluator with an in-memory SQLite host. Its options provide API modules, facet kinds and stub facets. The returned handles expose the plugin host, reports and close operation.
