# Node worker hosts

`@axi/objects/workers` starts one Node process per object-host address. The [declarations](../dist/node/workers/index.d.ts) describe its types. A worker process can host a Durable runtime, but process management does not replace Durable's task scheduler.

## Parent process

`await createWorkers(host, Kind, options, context)` builds the worker entry and registers a route before host loading. A build failure rejects startup. Its `kind` selects the plugin facet kind. Bootstrap options name the entry module, Node arguments and environment overrides. The child inherits the parent environment with those overrides.

All workers of one kind use the code snapshot built at startup. Edits to its source take effect after the server restarts. Installed packages remain external; linked workspace packages are included in the snapshot. Literal dynamic imports become lazy chunks. `inputs` maps each source path to the SHA-256 hash of the bytes the build read. Source locations and stack traces point to those original files. If a temporary-file cleaner removes an output file, the component recreates the complete snapshot before the next fork.

`nodeBaseInputs(entry, conditions)` scans a Node entry's static imports and returns the same input-map format without writing or executing a bundle. Unresolved optional imports are excluded. Other build errors reject the scan. The app host uses this helper to detect edits to its server code.

A variable import resolves against its original source location and stays outside the snapshot. Shared chunks can change the execution order of modules that do not import one another. A running worker cannot import a chunk that was removed before the next fork restores it.

`authorize` decides whether a principal can reach an address. `principal` stamps the worker's link. `start` supplies JSON before each start, and `lock` names the cross-process ownership lock. `plugins` supplies the current prebuilt scripts. `onOutput` receives stdout and stderr; without it, output goes to the parent's corresponding stream.

`onOutput` runs without a bound `this` value. The supervisor sends process-group signals only when the fork returned a positive PID.

The first routed hold starts a child. Its IPC link exists from the fork, preserving early frames. The start deadline is 60 seconds for the fork, lock acquisition and parent-link connection. A separate ready message marks completion of application setup.

`state` is a JSON watchable keyed by address. Active entries have a starting, running or stopping status, PID and start time. Failed entries contain a public error and failure time. Detailed errors and the stderr tail go only to `onError`.

## Child process

The entry module imports `workerMain(fn, options)` from `@axi/objects/workers/child`. This entry also exports `processLock` and loads no compiler. The function receives its address, start data, parent link, plugin loader and `onClose` registration method. Connect a host to the parent before slow setup, register its closer, then load the supplied scripts through `plugins.load`.

The child's `hostPackages` contains its own module instances. Plugins use the separate prebuilt-script runtime, without importing esbuild. The function can return an additional `busy` watchable of numeric counts. Host references, jobs, lingering objects, extra busy counts and active reloads determine whether the worker is idle.

## Stop, retry and rollout

Idle workers stop after `idleMs()`, which defaults to five minutes and is checked every second. `stop(address, context)` suspends that address while holders remain and requests shutdown. `retry` clears failure and suspension and starts held work again.

A crash or failed start stays failed until retry or a worker rollout. A running worker whose link is lost gets five seconds to exit, then its process group is killed. Held references can start a replacement. This recovery is allowed once per minute for an address; another loss within that minute fails the address with `worker lost its link`. `onError` reports the recovered loss as `worker_link_lost`. There is no unrestricted restart loop. Public start errors use fixed messages. A child's fatal message uses its `redact` callback.

`workers.step(name)` joins a plugin rollout. It retries earlier failed addresses and ships the current script set to running workers. Results identify each host's report, clean stop or error. Cancelling a rollout wait does not cancel its outstanding child reload.

Shutdown aborts the child's context and runs registered closers in reverse order. The child has three seconds to exit; the parent kills the process group after five seconds. Closing the component removes its snapshot file, cancels starts and stops its children. It waits for pending lock cleanup before it resolves. Process locks wait for the current holder without polling. The serialized starter clears an unheld stale file socket before acquisition and preserves live holders.
