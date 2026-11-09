# Node HTTP component

`@axi/objects/http` connects an object host to HTTP and WebSocket clients. It requires Node and the optional `ws` peer dependency. The [declarations](../dist/node/http/index.d.ts) describe its types.

## Component lifetime

`createHttp(host, options, context)` returns a facet, `fetch`, a Node `upgrade` handler, `listening`, and `close`. Load its facet as a named core facet and retain the same facet object on reload.

`options.listen` contains the host and port for the built-in Node listener. Port zero selects an available port. Without this option, an application mounts `fetch(request, connection)` in its own server. `nodeRequest(message, response)` converts a Node request with the same wire checks and client cancellation. `options.links` selects an authenticated object-link WebSocket endpoint. Its options can vary by request and principal.

## Contributions and authentication

Plugins contribute to the `Http` registry through `self.contribute`. A contribution can contain routes, wrappers, sockets, allowed hosts, framing origins, verified relays and extra content-security-policy sources.

Route keys have the form `GET /notes/:id`. Exact segments take priority over parameters, then a trailing wildcard. HEAD falls back to GET for the same path. Parameters are decoded and refuse path separators, NUL and dot segments. Duplicate patterns produce a conflict and retain the first contribution.

Wrappers run in `observe`, `headers`, then `transform` order. They apply to their own plugin unless their scope is `all`.

The `Authenticators` registry contains ordered authentication functions. The first returned principal wins. A throwing function is reported and skipped. A request's `host.root` scope carries the selected principal and ends after the response body finishes or the client disconnects.

Authentication and route functions run without a bound `this` value. The `onError` callback receives the HTTP component as its `this` value.

## Admission and responses

A local request needs a loopback connection and a matching loopback Host and port. Other hosts require an explicit contribution. Forwarded loopback requests require a verified relay. Browser origin checks run before authentication. Routes without a principal return 401 unless explicitly public. Cross-site routes are public and run anonymously. Foreign requests cannot download byte responses.

Every response starts with no-store, no-sniff, no-referrer and framing restrictions, plus a content-security policy with a fresh script nonce. Route headers can override these defaults. Header names and values are checked before writing. Signed cookies use HMAC-SHA256, bind the cookie name, and enforce a signed expiry when configured.

Routes return JSON, HTML, redirects, errors or byte readers. Request bodies default to a one-MiB limit. Byte readers run with backpressure and support HEAD and optional single ranges. `fileResponse` checks an optional root after resolving symbolic links and opens its handle only on the first read.

## Shutdown and reload

Plugin sockets require authentication unless explicitly public and have a heartbeat. Removing their handler, allowed host or relay terminates affected connections. Object links also cap queued output.

Call `http.close(context)` before `host.close(context)`. It refuses new work, drains requests and closes sockets up to `closeTimeout`, which defaults to 30 seconds. It then seals remaining request scopes. This component provides transport and request ownership; it does not create a second agent scheduler.
