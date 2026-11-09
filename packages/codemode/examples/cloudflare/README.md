# Code Mode in separate Workers

The session Worker owns a counter tool. The sandbox Worker runs JavaScript and calls back to that tool through Workers RPC. Its service binding keeps the VM in a separate Worker. The counter lives in memory; this example does not persist it.

Build the toolkit and install Wrangler in your development environment. From this directory, run both Workers locally:

```sh
npx wrangler dev -c agent/wrangler.jsonc -c sandbox/wrangler.jsonc
```

Send a script:

```sh
curl -X POST http://localhost:8787 --data 'const value = await tools.count({ add: 2 }); text(value); return value;'
```

The result contains `value: 2` and one text output. Another request to the same running session adds to its counter. A GET request returns HTTP 405. The sandbox has no public route and returns HTTP 404 if reached directly.

For deployment, deploy `sandbox/wrangler.jsonc` first, then `agent/wrangler.jsonc`. Change the Worker's name and the binding's `script_name` together. A binding to a class inside the session Worker can share its thread and does not provide the same separation.

The remote class caps VM memory at 32 MiB and interrupt polls at 100,000 by default. Subclass `CodemodeSandboxDurableObject` to change those limits. A client's timeout or cancellation settles its result before a computing remote VM necessarily stops; the remote stops at its next exchange or interrupt limit.

The repository's `npm run test:workers` checks this example with local workerd, including two requests through the cross-Worker binding.
