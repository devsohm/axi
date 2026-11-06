# JSON revisions

`@axi/objects/delta` tracks changes to JSON values and produces operations that another copy can replay. The tracker owns one revision sequence. Storage, delivery order and network recovery belong to the caller.

## Edit a value

```ts
import { appendText, applyImmutable, track } from "@axi/objects/delta";

const tracker = track({ output: "", completed: 0 });
const change = tracker.beginChange();
appendText(change.state, "output", "Saved the file.\n");
change.state.completed += 1;
const prepared = change.prepare();
const replica = applyImmutable(prepared.base, prepared.ops);
tracker.adopt(prepared);
```

`prepare()` produces a candidate without publishing it. `adopt()` publishes that candidate. In the example, `replica` and `tracker.value` contain the same JSON value. They can share nested objects with the previous revision and operation payloads.

Call `abort()` when abandoning a change. Preparing, aborting or adopting ends the draft's lifetime. Adopting another candidate also makes competing drafts and preparations stale. Even a candidate with no operations advances the tracker revision when adopted.

Use `prepareReplace(value)` to transfer a complete replacement into the tracker. A deeply equal replacement keeps the existing root and produces no operations. Other replacements produce one root operation.

## Ownership

Treat roots passed to the tracker, published values, preparations and their operations as immutable. The implementation does not freeze them. Mutating a retained value can corrupt later revisions or replicas.

Roots must be acyclic JSON trees without shared containers. Arrays must be dense. Objects must have the ordinary or null prototype and enumerable data properties. Values can contain finite numbers, strings, booleans and null. Accessors, symbols, functions, class instances and undefined values do not belong in a root.

Values assigned into a draft are validated and copied. The caller can keep editing its original value afterward. A failed placement leaves the draft unchanged. Assigning undefined to an object property deletes it. Undefined array elements are rejected. Increasing array length fills new positions with null.

Draft arrays support push, pop, shift, unshift, splice, reverse, sort, fill and copyWithin. A retained element handle follows its element when indices change. Comparators and coercion callbacks must not change or settle the draft.

## Replay operations

Paths contain object keys and non-negative integer array indices.

| Operation | Effect |
| --- | --- |
| `r` | Replace the root. |
| `s` | Set a property or element. |
| `d` | Delete a property or remove an element. |
| `a` | Append text. |
| `t` | Remove UTF-16 code units from the beginning of text. |
| `p` | Splice an array. |
| `m` | Reorder an array by a permutation. |

Operation sequences preserve the resulting value. Their exact arrangement can vary. `diffRevisions(before, after)` computes a sequence from two existing revisions. It cannot recover how a caller originally edited them.

`applyImmutable()` keeps its inputs unchanged and shares unchanged containers. `applyImmutableBatches()` replays an ordered backlog within one copying pass. Keep only its final result. Use separate calls when intermediate revisions must remain available.

`apply()` mutates its input and adopts operation payloads. Give each mutable replica its own detached starting value and detached batches. Sharing one batch between mutable replicas can make them change each other.

Appliers validate operation shapes and paths. They reject `__proto__`, `constructor` and `prototype` path segments. A tracker edit involving those keys becomes a safe ancestor replacement. Validate payload JSON at the boundary when operations come from an untrusted source.

## Streaming and slow readers

Use `appendText()` when text grows repeatedly. It receives the new fragment directly and avoids comparing the complete old and new strings on every edit. A normal assignment such as `draft.output += fragment` can require work proportional to the whole string.

`PendingOps` keeps ordered changes for a reader that is behind. It combines compatible leaf operations without changing the received batches. Structural operations end the current leaf-folding region. If folding exceeds 10,000 operations, `take()` requests a replacement instead. The owner supplies its current value as a root operation. One batch is initially retained as received, even if it is large.

`encoder()` and `decoder()` compress repeated paths across ordered batches. Keep one pair for each stream. A root replacement resets their path dictionaries. After a missing frame or replay error, discard the decoder and replica and resume from a complete root replacement.
