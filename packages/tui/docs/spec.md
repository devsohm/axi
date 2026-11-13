# Terminal UI specification

This document describes the terminal library contracts. Native clipboard backends are implemented for Linux, macOS and Windows. The verification workflow builds and tests each desktop target. Native checks and automated terminal scenarios do not establish visual appearance in every terminal application.

## Input framing

`StdinBuffer` separates text and complete terminal escape sequences. It retains partial sequences across input chunks and flushes an incomplete sequence after a timeout. A lone Escape uses a separate timeout. Both timeout values are captured at construction. Recognized terminal replies wait for their terminator instead of timing out into key events. Bracketed paste emits one paste event; pasted controls do not become ordinary key events. Clear and destroy cancel pending timeouts and discard incomplete input.

Input following a completed paste stays separate while paste listeners run. A listener can clear or flush the buffer without consuming that trailing input. Input submitted by the listener is processed before the saved tail.

## Keyboard input

Key matching accepts legacy terminal sequences, Kitty keyboard reports and xterm modified-key reports. Key identifiers support Shift, Control, Alt and Super combinations. Kitty lock bits do not change binding identity. Alternate layout keys are used when the reported character does not already identify a supported logical key. Printable decoding excludes command modifiers.

The keybinding manager resolves application overrides against declared defaults. Rebinding one action does not remove another action with the same key. Conflicts report keys explicitly assigned to multiple actions by the user. Applications can extend the keybinding interface through declaration merging.

Input listeners receive raw events before the focused component. This includes key-release reports. A listener that toggles a control must check `isKeyRelease(data)` before matching its shortcut. The renderer filters releases before delivery to a component unless that component sets `wantsKeyRelease`. `matchesKey()` identifies the key binding; it does not discard release events.

## Process terminal

Starting the process terminal enables raw input and bracketed paste, installs input and resize listeners, and queries keyboard protocol support. Input is framed before delivery. The terminal consumes its negotiation replies and forwards unrelated replies to the caller. Stopping removes listeners and restores the previous raw-mode setting. Draining temporarily suppresses input callbacks and waits for late input until an idle period or deadline.

`AXI_TUI_ESC_TIMEOUT` controls the Escape framing timeout. SSH defaults to a longer timeout. `AXI_TUI_WRITE_LOG` optionally records explicit write calls. Native clipboard and modifier loaders return unavailable when a matching platform binary is absent. The Linux X11 backend supports asynchronous text and image reads, bounded transfers and unavailable-display results. The macOS and Windows backends provide clipboard writes and modifier state. macOS also provides file paths, and Windows provides virtual terminal input.

## Search and colors

Fuzzy matching accepts ordered subsequences and ranks consecutive and word-boundary matches ahead of distant matches. Filtering requires every whitespace- or slash-separated query token to match. Empty queries return the supplied array.

Terminal color parsing recognizes default foreground, background and indexed palette replies. Channels are normalized to 8-bit RGB. An invalid color reply retains its target with an undefined RGB value. Unrelated input returns undefined.

## Terminal text

Widths use terminal cells rather than string length. Tabs occupy three cells. Width measurement ignores supported CSI, OSC and APC sequences. Grapheme segmentation keeps combined characters together; CJK text and emoji use their terminal widths.

Column slicing preserves the order of control sequences. Strict slices exclude wide graphemes that cross the end boundary. Truncation retains a contiguous prefix and closes an active hyperlink before the ellipsis. Word wrapping preserves active styles and hyperlinks across continuation lines.

## Components and input

Components render arrays of terminal lines and expose invalidation. Containers concatenate their children and translate mouse coordinates to the receiving child. Boxes add padding and optional backgrounds. Text wraps within its horizontal padding. Truncated text displays only its first line.

`Text.setText()` retains its wrapped output when the supplied text is unchanged.

The single-line input supports grapheme and word navigation, deletion, kill and yank history, undo, bracketed paste, placeholders and horizontal scrolling. Paste removes line breaks and expands tabs to four spaces. Consecutive word typing forms one undo unit. Whitespace, cursor movement and deletion establish separate undo boundaries.

The cursor marker uses Axi's identity. A focused input emits it before the highlighted cursor grapheme. The renderer consumes this marker to position the terminal cursor.

## Word navigation

Cursor positions use UTF-16 offsets. Forward navigation skips leading whitespace and then one word, punctuation run or atomic segment. Backward navigation skips trailing whitespace and then the preceding unit. Word boundaries use `Intl.Segmenter`. Callers can supply a segmenter and identify atomic segments such as paste markers.

## Deleted-text history

`KillRing` ignores empty text. A push either adds an entry or accumulates text into the most recent entry. Backward deletions prepend text. Forward deletions append it. Rotation moves the newest entry to the oldest position. Reading the newest entry does not mutate the ring.

## Undo snapshots

`UndoStack` clones values with `structuredClone` when they are pushed. Pop returns the most recent stored snapshot without another clone. Clear removes all snapshots. Empty stacks return `undefined`.

## Runtime ownership

The terminal library must remain independent of Durable. Application code subscribes to Durable conversation state, converts it into message and tool components and requests rendering. Editor actions call application commands. The runtime owns model calls, tasks, storage and recovery. Closing the application releases subscriptions, stops terminal input and closes the runtime.

## Renderers and layout

`TuiMainScreen` renders into terminal scrollback. `TuiAltScreen` owns a fullscreen viewport. Both share focus, overlays, terminal color negotiation, input filtering and cursor handling.

`VStack` and `HStack` allocate space using basis, grow, shrink, minimum and maximum sizes. Visibility predicates receive viewport dimensions. `ScrollView` holds one child and supports follow-end, nested wheel scrolling, and hidden, transient or reserved scrollbars. Layout clips text and images to the viewport.

Fullscreen mode supports transcript search, configurable navigation, mouse selection and clipboard callbacks. Text selection respects grapheme boundaries; double-click selects words and triple-click selects lines. The default copy path writes OSC 52. Applications can inject a clipboard implementation. Image caching bounds offscreen Kitty images by count, transmission bytes and decoded size. Stopping restores terminal input and screen settings.

Fullscreen redraws retain uploaded Kitty image data for placement reuse, including after a resize.

Overlays hide Kitty and iTerm2 images whose terminal cells intersect the overlay, including images starting above or below its text row. Closing the overlay restores the image. Images beside the overlay remain visible. An image with an unknown width is treated as extending to the right edge. Higher overlays also hide images drawn by lower overlays.

## Multiline editor and completion

The editor stores cursor positions as UTF-16 offsets and moves across grapheme boundaries. It wraps text to terminal width, preserves the preferred column during vertical movement, and scrolls the visible editor window. It supports undo, history, kill and yank, mouse positioning, bracketed paste and large-paste markers. Applications supply submission callbacks, themes and completion providers.

Completion requests are cancellable. New input invalidates earlier requests. Combined completion handles commands, command arguments, resource names and filesystem paths. The application supplies its command catalog and optional file-search executable.

## Markdown and mathematical notation

Markdown renders headings, paragraphs, lists, task lists, quotes, fenced code, links and tables. Applications provide theme functions and optional syntax highlighting. Links use terminal hyperlinks when supported and readable destinations otherwise. Streaming partial fences and mathematical expressions remain renderable.

Hard breaks after inline images remain separate rendered rows.

Markdown reuses unchanged top-level blocks while text streams. A resize recalculates wrapping and retains cached code highlighting. Call `invalidate()` after changing theme functions or their output. It clears the block results, highlighting and default style prefix. These caches use weak references and can be collected between renders. Changed reference-link definitions always use the current text.

Emphasis recognizes CJK text next to punctuation. Latin text retains the standard delimiter rules.

Mathematical notation supports inline Unicode symbols, scripts, fractions, roots and multiline layouts. Unsupported expressions return no mathematical rendering so callers can retain the original text.

## Color utilities

Color helpers convert sRGB, Oklab, OKLCH and OKHSL values, parse hexadecimal and indexed colors, mix colors, and construct ANSI styles. Style helpers wrap text in opening codes and matching resets in reverse order. Existing escape sequences are preserved.
