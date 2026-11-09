# Native terminal helpers

The Linux helper reads X11 clipboard text and images through XCB. It does not launch clipboard commands or connect to a display until a read is requested. An unavailable display returns `undefined`; an empty clipboard returns `null`; a failed transfer rejects the promise.

A transfer has a two-second deadline and a 50 MiB limit. Connection setup runs on a private thread. A three-second bounded wait prevents a stalled display from occupying a Node worker indefinitely. Other reads return unavailable while that transfer is active. Late results release their buffers before another transfer starts.

## Build on the current platform

On Linux, install a C compiler, Node development headers and the XCB development library. On macOS, install the Xcode Command Line Tools and Node development headers. On Windows, use a Visual Studio developer prompt for the target architecture. Set `NODE_INCLUDE_DIR` to the Node header directory and `NODE_IMPORT_LIBRARY` to its matching `node.lib`.

From the toolkit root, run:

```sh
npm run build:native -w @axi/tui
npm run test:native -w @axi/tui
```

Set `NODE_INCLUDE_DIR` if `node_api.h` is outside the standard include directories. Set `CC` to select the compiler. Builds target the current architecture. Linux ARM64 builds request 64 KiB ELF segment alignment.

The first test creates a private stalled TCP server. It checks responsiveness, bounded concurrency, timeout behavior and cleanup after a late connection failure. If `Xvfb` and `xclip` are on `PATH`, a second test checks empty, Unicode, Latin-1 and large incremental selections in a private virtual display. Neither test reads or replaces the desktop clipboard.

The macOS helper uses the system pasteboard for text, images and file paths. It also reports modifier state. The Windows helper supports Unicode text, PNG and bitmap clipboard images, modifier state and virtual terminal input.

The shared Node-API bridge test compiles a test backend and checks values, writes and errors in a child process. Native platform loading has a separate test. These tests do not replace desktop acceptance on each operating system.
