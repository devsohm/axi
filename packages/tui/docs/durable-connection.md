# Connect a terminal application to Durable

The terminal library does not import Durable. An application imports both libraries and connects them through a runtime adapter.

## Startup

The application loads settings and authentication, selects a session and acquires its lock. It opens SQLite storage and creates a registry of tools and extensions. It then opens the harness with its model runtime and execution environment.

The runtime adapter selects a conversation and attaches to `conversation.watch(context)`. The application reads the attached value for its initial display and calls `start(async value => ...)` to receive subsequent changes. It can also attach to `harness.watchTaskGraph(context)` for a task panel.

## Display updates

The conversation view contains transcript entries and mounted agent documents. The application converts these values into message cards, tool output, queued-input indicators, usage and status components. A change subscription requests a terminal redraw.

The runtime owns partial model responses, tool progress, retries, compaction and recovery. The display does not reconstruct these states from a separate model event loop.

## Input

The editor submits text through `conversation.submit(draft, context)`. The draft selects steering or follow-up behavior when the conversation is busy. Abort targets the displayed conversation. Application commands select models, change thinking levels, compact history and switch the displayed conversation.

Switching conversations releases the old view attachment, attaches to the selected conversation and changes the destination for editor commands. It does not open a second harness.

## Shutdown

The application stops new input, removes subscriptions and disposes view attachments. It stops the terminal UI and closes the harness and session resources. Shutdown must run in a `finally` block so an interface error does not leave terminal modes or session resources active.

## Package boundaries

- TUI owns terminal protocols, rendering, layout and reusable widgets.
- Durable owns conversations, tasks, execution, commits and recovery.
- The application owns authentication, settings, session selection, commands, themes and message presentation.

The application adapter and message presentation are not implemented in this package yet.
