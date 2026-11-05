# Store sync

`@axi/objects/sync` is an experimental API for copying committed Store history to a remote and restoring it elsewhere. The application supplies the remote, local progress storage and scheduling. Sync does not start tasks or merge concurrent edits.

## Client operations

Open a source Store with `{ outbox: true }`. The outbox retains applied writes until a successful upload trims them.

| Operation | Result |
| --- | --- |
| `uploadSession(options)` | Uploads pending commits or an initial archive. Returns `uploaded`, `idle`, `diverged`, `behind` or `stale_epoch`. |
| `pullSession(options)` | Restores into an empty backend or advances a Store that has no unsynced local work. Returns the Store and its head sequence. |
| `foldSession(options)` | Restores history into a scratch backend, writes a snapshot and removes covered batch bodies. Closes the scratch Store. |
| `readOutbox(store, after, limit, context)` | Reads retained commits. Throws `OutboxUnavailableError` when the requested prefix has been trimmed. |
| `storeHead(store)` | Returns the last committed sequence. |

Each client call takes a session ID and a cancellation context. Upload also takes a stable writer ID and an optional epoch. A remote implementation can use the epoch to reject a previous writer after ownership changes.

Pull requires exclusive access to the local Store. Close any Harness or `StoreStorage` claims before applying remote commits. The caller owns the returned Store and closes it. For large histories, folding needs a file-backed scratch database so restored data does not occupy only memory.

`SyncStateStore` saves `syncedHead` and an optional `pulling` target. Pull writes that target before applying a batch. A retry skips the applied prefix. Local commits beyond the shared head raise `UnsyncedCommitsError`. A missing remote prefix raises `HistoryUnavailableError`.

A lost upload reply can leave the remote ahead of local progress. Retrying with the same writer ID recognizes the accepted slot and advances local progress. A different writer at that slot returns `diverged`. Resolving divergence is an application decision.

## Remote contract

`SessionSyncStore` stores batch bodies, lists slots and snapshots, reads session metadata and lists sessions. `SessionSyncMaintenance` adds snapshot publication and history cleanup.

A batch slot identifies its preceding sequence, final sequence and writer. Its body is a `SyncBody`, an asynchronous stream of bytes. Slots also record whether a body is an archive or has been folded into a snapshot.

`remoteHistory(listing, from)` selects a snapshot and the following batch chain. `remoteHead(listing)` follows the slot chain from sequence zero. Folded slots keep their writer and sequence information after their bodies are removed.

## Encoding and bounds

`encodeBatch()` writes gzip-compressed UTF-8 JSON lines. Each line contains `v`, `seq`, `nextId` and `writes`. `LOG_VERSION` is `2`. `decodeBatch()` rejects malformed envelope fields, invalid UTF-8, non-increasing sequences and an incomplete final line. Applying the batch validates its writes.

`encodeSnapshot()` compresses the Store archive JSONL format. `decodeSnapshot()` yields archive records for the existing importer.

`BATCH_BYTES` targets 8 MiB before compression. `APPLY_BYTES` targets 4 MiB of decoded lines per apply transaction. A single commit can exceed either target. These values are batch targets, not maximum accepted document sizes.

## Filesystem remote

`FileSystemSyncRemote(files, root)` accepts portable `SyncFileSystem` operations. Durable's `NodeExecutionEnv` implements those operations. The adapter writes temporary files, renames each completed body and publishes its slot last.

The directory layout for session `chat` is:

```text
root/chat/
  slots/0000000000000000.json
  batches/0000000000000000.batch
  snapshots/0000000000000012.batch
  meta.json
```

The slot and batch filename contains the preceding sequence. The snapshot filename contains its final sequence. `checkSessionId()` rejects names that could escape the session directory.

This adapter supports one writer process. It has no cross-process compare-and-set and does not enforce writer epochs. Its session listing returns all sessions without pagination. A production shared remote must implement its own concurrency control.

`FileSyncStateStore(files, directory)` saves client progress in one JSON file per session. It replaces files through a temporary file and rename. `delete()` removes a session's local progress.

## Flush scheduling

`FlushScheduler` takes the upload callback, clock, timer factory and error callback. `notify(false)` schedules within 5 seconds. `notify(true)` uses 200 milliseconds. An earlier due time takes priority.

Only one flush runs at a time. Changes during a flush request a later pass. Failures retry after 1 second, then double the delay up to 60 seconds. Options can replace these defaults. `close()` cancels the timer, waits for active work and runs a final flush. Its rejection reaches the caller.
