<h1 align="center">litepack</h1>
<p align="center">
  <em>📦 Lightweight binary schema encoding — define a schema, encode to bytes, decode back. Zero dependencies.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/litepack">
    <img src="https://img.shields.io/npm/v/litepack?color=blue" alt="npm">
  </a>
</p>

---

## Why litepack?

JSON is great — until you're sending thousands of small messages over
WebSockets, WebRTC data channels, or storing millions of tiny records.
Then every message pays for its own key names, quotes, and decimal digits:

```js
// JSON — 91 bytes:
{"type":64,"sub":8,"subjectPeerId":918273645,"name":"peer-x1","vals":[1,22,333,4444,55555]}

// litepack — 25 bytes. Same data:
40 08 ED FC EE B5 03 07 70 65 65 72 2D 78 31 05 01 16 CD 02 DC 22 83 B2 03
```

The schema lives in your code (or a shared JSON file), so key names never
travel. Integers use variable-length encoding — small numbers cost 1 byte.
Enums become indices. Flags pack into bits. **70–90% smaller than JSON** on
typical structured messages.

**One value, one encoding.** litepack 2.0 is strict both ways: `encode`
never coerces (a string where a number belongs, `1.7` for an integer, a
missing field — all throw), and `decode` accepts only the exact bytes
`encode` would write (no padded varints, no trailing bytes, no unknown bits).
So the bytes can be hashed, signed, deduplicated and compared safely.

### When to use it

* 🔌 **Real-time messaging** — WebSocket / WebRTC / TCP protocols where
  messages are small and frequent (presence updates, game state, signaling,
  telemetry). This is where per-message overhead dominates.
* 📱 **Mobile & metered connections** — every byte is battery and quota.
* 💾 **Compact storage** — millions of small records in IndexedDB, Redis,
  or files.
* ✍️ **Canonical bytes for signing** — deterministic output, unlike
  `JSON.stringify` (which depends on key order), and a decoder that accepts
  nothing else: no two byte strings decode to the same message.

### When NOT to use it

* Human-readable configs and logs — use JSON.
* Large repetitive payloads — litepack is compact *encoding*, not
  *compression*; run gzip/deflate on top (or instead) for multi-KB blobs.
* Schemaless data — if you truly can't know the shape ahead of time,
  use the built-in `json` field type as an escape hatch, or CBOR/MsgPack.

## 📖 Contents

* [Installation](#-installation) · [Quick Start](#-quick-start) · [Complete example](#-complete-example-clientserver-over-websocket)
* [What the bytes look like](#-what-the-bytes-look-like) · [Types](#-types) · [Field options](#-types) · [Named types & recursion](#named-types--recursion) · [Limits](#limits-min--max)
* [API](#-api) · [Schema identity](#schema-identity) · [Errors](#errors) · [Streaming & chaining](#-streaming--chaining-multiple-messages-one-buffer)
* [Real-world examples](#-real-world-examples) · [Schema evolution](#-schema-evolution) · [Robustness](#-robustness-model)
* [Performance](#-performance) · [Size comparison](#-size-comparison) · [Moving from Protocol Buffers](#-moving-from-protocol-buffers)
* [Migrating from 1.x](#-migrating-from-1x-to-20) · [Common pitfalls](#-common-pitfalls) · [How does it compare?](#-how-does-it-compare)

## 📦 Installation

```
npm i litepack
```

Or just drop `litepack.js` into your project — it's a single UMD file.
All of these work:

```js
// Node.js / bundlers
var litepack = require('litepack');
import litepack from 'litepack';

// Browser — plain script tag → global
<script src="litepack.js"></script>
<script> litepack.encode(schema, data); </script>

// Service Worker
importScripts('/js/litepack.js');     // → self.litepack
```

Runs in Node.js, browsers, Service Workers, Bun and Deno. TypeScript
declarations (`litepack.d.ts`) give you autocomplete even in plain-JS
projects — just keep the file next to `litepack.js`. In TypeScript the data
type follows from the schema ([TypeScript](#typescript)).

## 🚀 Quick Start

```js
var litepack = require('litepack');

// 1. Define a schema — an array of [name, type] pairs
var userProto = [
    ['id',     'varint'],
    ['name',   'string'],
    ['email',  'string?'],    // ? = optional, costs 0 bytes when absent
    ['age',    'uint8?']
];

// 2. Encode
var buf = litepack.encode(userProto, {
    id: 12345, name: 'Aviv', email: 'aviv@example.com', age: 30
});
// → Uint8Array(26)   (62 bytes as JSON)

// 3. Decode
var user = litepack.decode(userProto, buf);
// → { id: 12345, name: 'Aviv', email: 'aviv@example.com', age: 30 }

// 4. Decoding bytes from the network? Use tryDecode — it never throws:
var msg = litepack.tryDecode(userProto, untrustedBytes);
if (!msg) return;   // malformed / truncated / hostile input — dropped
```

## 🔄 Complete example: client/server over WebSocket

Both sides share one schema module — that's the entire "protocol spec":

```js
// ── shared/protocol.js — the single source of truth ──────────────
var OP = { CHAT: 1, MOVE: 2 };

var chatProto = [
    ['op',   'const', 'uint8', OP.CHAT],   // written & verified automatically
    ['from', 'varint'],
    ['text', 'string']
];

var moveProto = [
    ['op', 'const', 'uint8', OP.MOVE],
    ['id', 'varint'],
    ['x',  'svarint'],
    ['y',  'svarint']
];

// ── sender (either side) ─────────────────────────────────────────
socket.send(litepack.encode(chatProto, { from: myId, text: 'hi!' }));
socket.send(litepack.encode(moveProto, { id: myId, x: -3, y: 12 }));

// ── receiver (either side) ───────────────────────────────────────
socket.onmessage = function(event) {
    var buf = new Uint8Array(event.data);
    var op = buf[0];                          // opcode is always byte 0

    var msg = op === OP.CHAT ? litepack.tryDecode(chatProto, buf)
            : op === OP.MOVE ? litepack.tryDecode(moveProto, buf)
            : null;
    if (!msg) return;                          // unknown op / malformed / hostile

    if (op === OP.CHAT) showChat(msg.from, msg.text);
    if (op === OP.MOVE) moveEntity(msg.id, msg.x, msg.y);
};
```

That's the whole pattern: shared schemas, `encode` out, `tryDecode` in,
`const` validating the opcode for free. Everything else in this README is
refinement of this loop.

## 🔍 What the bytes look like

Understanding the wire format takes one example. Take this schema and data:

```js
var proto = [
    ['id',    'varint'],
    ['flags', 'bits', [['active',1], ['mode',3]]],
    ['name',  'string'],
    ['email', 'string?']
];
litepack.encode(proto, { id: 300, flags: { active: 0, mode: 0 }, name: 'Dan' });   // email omitted
```

Wire bytes: `00 AC 02 00 03 44 61 6E`

| Bytes | Meaning |
|---|---|
| `00` | optionals bitmask — 1 varint for ALL optional fields; `email` absent → bit 0 clear |
| `AC 02` | `id` = 300 as varint (values 0–127 take 1 byte, 128–16383 take 2…) |
| `00` | `flags` — 4 bits packed into 1 byte |
| `03` | `name` length prefix (3) |
| `44 61 6E` | `"Dan"` in UTF-8 |

`email` costs **zero** bytes when absent. There are no field names, no
delimiters, no type tags — the schema on both sides is the contract.

## 📋 Types

**Cheatsheet** — every type at a glance:

| Type | Wire size | Use for |
|---|---|---|
| `uint8/16/32`, `int8/16/32` | 1/2/4 B fixed | values with a known range |
| `uint64`, `int64` | 8 B | file sizes, big ids (Number; `{bigint:true}` for BigInt) |
| `varint` | 1-8 B | counts, ids, timestamps — usually small, sometimes big |
| `svarint` | 1-8 B | signed deltas, coordinates |
| `timestamp` | = varint | readability alias |
| `float32/64` | 4/8 B | real numbers |
| `bool` | 1 B | single flag (many flags → `bits`) |
| `string` | len + UTF-8 | text |
| `bytes` | len + raw | binary blobs |
| `fixed`, `uuid` | exactly N / 16 B | hashes, keys, ids — no prefix (arrays of them too) |
| `tail` | rest of buffer | final blob, top-level last field only |
| `enum` | 1+ B index | one choice from a list |
| `set` | 1+ B bitmask | multiple choices from a list (≤52) |
| `bits` | packed | several small ints in minimal bytes |
| `const` | = base type | protocol constants — auto-written, verified |
| `struct` | inline | nested object |
| `array` | count + items | lists, incl. arrays of structs |
| `ascending` | count + gaps | sorted sets of integers (ids, ranges, indices) |
| `deltas` | count + steps | integer series (timestamps, counters, coordinates) |
| `bitset` | count + bits | many booleans, 1 bit each |
| `map` | count + pairs | dynamic keys, typed values |
| `json` | len + JSON | free-form escape hatch |
| *(custom)* | len + codec | anything via `litepack.codec()` |

Any type + `?` = optional (zero bytes when absent). Lengths, counts and
numbers take `{min, max}` limits (see [Limits](#limits-min--max)).

**How a field is written.** `[name, type, ...what it is made of, {options}]`
— the positions say what the type consists of (an enum's names, a struct's
fields, an array's item type, a fixed length); the options object, always
last, says everything else:

| option | applies to | meaning |
|---|---|---|
| `optional: true` | any field | may be absent — same as `type?` |
| `default: v` | optional fields | value decode gives when absent |
| `min`, `max` | lengths, counts, numbers | [limits](#limits-min--max) |
| `chars: 'a-z0-9_'` | `string` | [alphabet](#strings-over-an-alphabet-chars) |
| `count: N` | `array` | fixed length, no count on the wire |
| `variants: {...}` | integer, string, bool or enum tag | [tagged union](#variants-tagged-union) |

An unknown option, or an option on a type it does not apply to, is a
compile error — a typo never passes silently.

### Integers

```js
['level',    'uint8']       // 0..255                    (1 byte)
['temp',     'int8']        // -128..127                 (1 byte)
['port',     'uint16']      // 0..65535                  (2 bytes)
['altitude', 'int16']       // -32768..32767             (2 bytes)
['color',    'uint32']      // 0..4294967295             (4 bytes)
['time',     'int32']       // signed 32-bit             (4 bytes)
['filesize', 'uint64']      // 0..2^64-1                 (8 bytes, see 64-bit below)
['balance',  'int64']       // signed 64-bit             (8 bytes, see 64-bit below)
['count',    'varint']      // unsigned, variable size   (1 byte for 0-127, 2 for 128-16383…)
['delta',    'svarint']     // SIGNED varint (zigzag)    (-1 → 1 byte; small magnitudes stay small)
```

**Choosing between them:** `varint` for counts, ids, timestamps — anything
usually small but occasionally big. Fixed-width types (`uint32` etc.) when
the value is uniformly distributed (hashes, colors) — a varint would
*cost* more there. `svarint` for deltas and coordinates that go negative.

> ⚠️ Every integer type is strict: the value must be a JS integer of the
> right kind and in range, or it **throws** — no masking (`300` as `int8`),
> no flooring (`1.7` as `varint`), no "not a number, so 0" (`'5'`). `varint`
> is unsigned (negative → use `svarint`) and stops at 2^53-1 (use `uint64`).
> A `BigInt` is accepted wherever its value fits.

**64-bit.** `uint64`/`int64` encode from a Number (a safe integer) or a
BigInt. They decode to a Number, and a value beyond 2^53 **throws** — 1.x
returned a BigInt for those values only, so one field came back as two
types. If the field can hold big values, decode with `{bigint: true}` and
always get a BigInt (slower: about 25-50% on a message of 64-bit fields,
which is why it is an option).

### Floats & Bool

```js
['temperature', 'float32']  // 32-bit IEEE 754 (4 bytes)
['precise',     'float64']  // 64-bit IEEE 754 (8 bytes)
['active',      'bool']     // true/false (1 byte — pack many bools with 'bits' instead)
```

### Strings & Bytes

```js
['name',    'string']       // UTF-8 with varint length prefix
['payload', 'bytes']        // raw bytes with varint length prefix
['body',    'tail']         // last field ONLY — the rest of the buffer, no prefix
['hash',    'fixed', 32]    // exactly 32 bytes, no length prefix (SHA-256, keys, UUIDs)
```

`fixed` saves the length prefix when the size is known — a SHA-256 hash is
32 bytes on the wire, not 33. `tail` saves it for the final variable blob.

`fixed` and `uuid` are **strict on encode**: the value must be bytes
(`Uint8Array`, `Buffer`, `ArrayBuffer`, or an array of integers 0..255) of
exactly that length. Anything else throws — a 64-character hex string given
to `['hash','fixed',32]` is a bug, not 32 bytes to cut it to. Decode
hex/base64 to bytes first. A missing value throws, like any missing required
field. `bytes` and `tail` take the same inputs; other typed arrays are
refused (`Int16Array([300])` would otherwise go out as `44`).

Lists of hashes or keys: `['keys', 'array', 'fixed', 32]` (each item exactly
32 bytes), or with a fixed count `['pair', 'array', 'fixed', 32, {count: 2}]`.

> ⚠️ On decode, `bytes` / `fixed` / `tail` return **views** into the input
> buffer (zero-copy, fast). If you reuse or mutate the network buffer after
> decoding, copy first: `new Uint8Array(msg.payload)` — or decode with
> `{copy: true}`.

#### Strings over an alphabet (`chars`)

```js
['user', 'string', {chars: 'a-z0-9_.', max: 20}]   // 38 characters → 6 bits each
['mail', 'string', {chars: 'a-z0-9.@_+-'}]
['word', 'string', {chars: ' א-ת'}]                  // Hebrew: 5 bits, against 16 in UTF-8
```

Only the listed characters are accepted — on encode and decode — and each
is stored in the fewest bits that index the alphabet: 5 bits for up to 32
characters, 6 for up to 64, 7 for up to 128. `a-z` is a range; a `-` first
or last stands for itself. With `max`/`min`, the limit counts characters.

| value | `string` | `chars` |
|---|---|---|
| `aviv_cohen` (`a-z0-9_.`) | 11 B | 9 B |
| `aviv.cohen+news@example.com` (`a-z0-9.@_+-`) | 28 B | 22 B |
| `שלום עולם` (` א-ת`) | 18 B | 7 B |

The validation is often worth more than the bytes: a username field that
cannot carry a character outside its alphabet. Encoding is as fast as a
plain string; decoding is ~15% slower.

**Not before gzip/brotli.** Packed bits no longer line up with bytes, which
is what general compressors feed on: 1,000 username+email records are 22%
smaller packed (29.7 KB vs 38.3 KB), but 42% *larger* after gzip (11.2 KB vs
7.9 KB) and 28% larger after brotli. Use `chars` for messages sent as they
are; leave text plain in anything you compress afterwards.

The alphabet is part of the schema (and its `schemaId`): appending a
character is a wire change, and one that crosses 32, 64 or 128 characters
changes every character's width.

#### Understanding `tail`

The idea behind `tail` is one simple observation: **your transport already
knows where the message ends.** A WebSocket frame, a datagram, a
length-prefixed TCP frame — they all carry a message boundary. So a length
prefix on the *final* blob inside the message is redundant information.
`tail` deletes it: "everything from here to the end of the buffer".

Where it shines:

**1. Envelope + opaque payload (tunneling).** A relay forwards a message
without understanding its contents — it reads the header and passes the
`tail` along untouched:

```js
var envelopeProto = [
    ['type',     'const', 'uint8', MSG.RELAY],
    ['fromPeer', 'varint'],
    ['toPeer',   'varint'],
    ['payload',  'tail']          // a complete inner message — not our business
];

// Layered protocols fall out naturally — the tail is itself decodable:
var outer = litepack.tryDecode(envelopeProto, wireBytes);
var inner = litepack.tryDecode(innerProto, outer.payload);
```

**2. Small header + big data (file/media chunks).** The byte saved by the
missing prefix is nice; the real win is **zero-copy** — the decoded `tail`
is a view into the receive buffer, so a 16 KB chunk is never copied:

```js
var chunkProto = [
    ['fileId',     'varint'],
    ['chunkIndex', 'varint'],
    ['data',       'tail']
];
```

**3. Signed raw bytes.** `header + the exact bytes that were signed` —
`tail` hands them back byte-for-byte, untouched by any encoding.

**`bytes` vs `tail` — the rule:** use `bytes` when something comes after
it, or when it lives inside a struct or array item (a length is *needed*
to know where it ends). Use `tail` when it's the last thing in the message
and framing is the transport's job. That's also why the compiler enforces
"last field of a top-level schema only" — it's not an arbitrary limit,
it's the definition of when `tail` is meaningful at all. Inside nested
structs/arrays the compiler throws with a clear message pointing you to
`bytes`.

Put together, `[const opcode] [header fields] [tail payload]` is the
template for a near-perfect protocol message: every byte on the wire is
real information, zero structural overhead.

### Const (protocol constants)

```js
var msgProto = [
    ['type', 'const', 'uint8', 64],     // written automatically, VERIFIED on decode
    ['id',   'varint']
];

litepack.encode(msgProto, { id: 5 });   // no need to pass `type` — the schema owns it
litepack.tryDecode(msgProto, buf);      // returns null if byte 0 isn't 64
```

Perfect for message-type codes and magic bytes: the constant disappears
from your data objects, and every decode validates it for free — a frame
with the wrong msgcode is rejected before you look at it. If the data does
carry the field, it must equal the constant (a message object of another
type is a bug, and throws). Any simple base
type works, including `'string'` for protocol magic (`['magic','const','string','LP1']`).

### Map (dynamic keys)

```js
['counters', 'map', 'string', 'varint']        // { views: 100, clicks: 7 }
['names',    'map', 'varint', 'string']        // numeric keys: { 1001: 'Aviv' }
['peers',    'map', 'varint', 'struct', [      // struct values
    ['name', 'string'], ['online', 'bool']
]]
```

For when the *keys* aren't known ahead of time but the *types* are —
metadata, per-name counters, id-indexed records. Wire format: varint count
+ (key, value) pairs. Far more compact than the `json` type
(`{a:1,b:2,c:3}` → 10 bytes vs 20).

**Canonical order.** Keys are written sorted — numbers ascending, strings
by Unicode code point (the order of their UTF-8 bytes, reproducible in any
language) — so `{b:2,a:1}` and `{a:1,b:2}` give the same bytes. Decode
refuses keys out of order or repeated (1.x let the last one win). An object
whose keys are already in order costs nothing extra; an unsorted one is
sorted on every encode (about a third slower for a 5-key map).

### Timestamps & UUIDs

```js
['createdAt', 'timestamp']    // readability alias for varint (ms epoch fits fine)
['requestId', 'uuid']         // exactly 16 bytes, no length prefix
```

### JSON escape hatch

```js
['meta', 'json']   // any JSON-serializable structure
```

For the part of a message that's genuinely free-form. Not compact — it's
`JSON.stringify` with a length prefix — but always available.

> ⚠️ `json` is the one type that is **not canonical**: its bytes follow the
> object's key order, and decode does not check the text's form (sorting
> keys deeply would cost on every message). Keep it out of anything you hash
> or sign — use a `map` or a `struct` there.

### Enum & Set

```js
// Enum — single choice, stored as varint index
['status', 'enum', ['active', 'inactive', 'banned']]
// 'banned' → 1 byte on the wire (vs 8 bytes as a JSON string)

// Set — multiple choice, stored as one varint bitmask (like MySQL SET)
['perms', 'set', ['read', 'write', 'execute', 'admin']]
// ['read', 'execute'] → 1 byte (bits 0 + 2 = 0x05)
```

Strictness rules that catch real bugs:

* Encoding a value **not in the list throws** — a typo like `'inActive'`
  would otherwise silently become a *different valid value* (index 0).
* A raw non-negative integer passes through an enum on encode. On decode,
  an index beyond the list (or set bits beyond the options) **throws** —
  unless the schema is extensible (`{extensible: true}`), where it comes
  back as the raw number: a value defined by a newer peer.
* `set` supports up to **52 options** (varint bitmask limit) — more than
  that is a compile-time error, not silent corruption.

### Bits (Bitfield Packing)

```js
var s = [['flags', 'bits', [
    ['active',  1],     // 1 bit  — 0 or 1
    ['mode',    3],     // 3 bits — 0 to 7
    ['quality', 4]      // 4 bits — 0 to 15
]]];
// 8 bits total = exactly 1 byte on the wire

litepack.encode(s, { flags: { active: 1, mode: 5, quality: 12 } });   // → [0xDC]
```

Perfect for sensor readings, permissions, and protocol flags. Subfield
widths are 1–32 bits each; the total can exceed 32 bits — it packs
correctly across as many bytes as needed. Every subfield must be present
and fit its width (`mode: 8` in 3 bits throws instead of becoming `0`);
`true`/`false` count as 1/0. Unused padding bits must decode as zero.

On the wire the subfields form one big-endian integer, first subfield most
significant, padding in the top bits of the first byte — the same layout at
every width (see [SPEC.md](SPEC.md) §5).

### Struct (Nested)

```js
['address', 'struct', [
    ['city', 'string'],
    ['zip',  'uint32']
]]

// Structs nest arbitrarily deep:
['order', 'struct', [
    ['id', 'varint'],
    ['customer', 'struct', [
        ['name', 'string'],
        ['address', 'struct', [['city', 'string'], ['zip', 'uint32']]]
    ]]
]]
```

### Array

```js
['scores', 'array', 'uint16']            // varint count prefix + items
['rgb',    'array', 'uint8', {count: 3}] // fixed count — no prefix, saves a byte
['tags',   'array', 'string']
['roles',  'array', 'enum', ['admin', 'user', 'guest']]

// Array of structs — fully supported, including nested arrays inside:
['streams', 'array', 'struct', [
    ['streamId', 'varint'],
    ['fromPeer', 'varint'],
    ['toPeers',  'array', 'varint']
]]

// Array of structs with fixed count
['points', 'array', 'struct', [['x','float32'], ['y','float32']], {count: 2}]
```

There is **no need** to pre-encode struct entries into an `array` of
`bytes` — arrays of structs (with strings, optionals, enums, bits, and
nested arrays inside) work natively, and cost one length prefix *less* per
entry than the manual wrapping trick.

### Ascending (sorted integer sets)

```js
['ids', 'ascending']        // [3, 4, 10, 1000] → 04 03 00 05 dd 07 (6 bytes)
```

A strictly ascending array of non-negative integers (≤ 2^53−1), stored as a
count, the first value, then each gap minus one. Neighbouring values cost a
byte each however large they are — `[1000000, 1000001]` is 5 bytes against 7
for `array varint`. Encode refuses a repeated or descending value; decode
cannot produce one (any bytes decode to an ascending array), so the type is
canonical by construction. Good for id sets, sorted indices, and range
boundaries `[start0, end0, start1, end1, …]` of non-touching ranges.
Faster than an array of `{gap, len}` structs (≈3× on encode and decode).

### Deltas (integer series)

```js
['times', 'deltas']   // [1763000000000, 1763000001000, 1763000002000] → 11 bytes (varints: 19)
```

Integers of any sign, in any order, stored as differences: a count, then
each value minus the previous one (the first minus 0) as an `svarint`. Values
that move in small steps — timestamps, counters, positions — cost 1–2 bytes
each however large they are: 20 timestamps a second apart take 46 bytes,
against 121 as `varint`s. Each step must stay within ±(2^52−1).

### Bitset (packed booleans)

```js
['flags', 'bitset']   // 64 booleans → 9 bytes (array of bool: 65)
```

An array of `true`/`false`, one bit each: a count, then `ceil(count/8)`
bytes, item *i* in bit *i mod 8* of byte *i / 8* (least significant first).
Unused bits of the last byte must be zero. For a fixed set of *named* flags,
`bits` or `set` reads better; `bitset` is for many, unnamed ones.

### Variants (Tagged Union)

Different fields depending on a discriminator — one schema for a whole
message family:

```js
var msgProto = [
    ['seq',  'varint'],
    ['kind', 'uint8', { variants: {
        '1': [['text', 'string']],                                   // chat
        '2': [['width', 'uint16'], ['height', 'uint16'], ['data', 'bytes']],  // image
        '3': [['lat', 'float64'], ['lon', 'float64']]                // location
    }}]
];

litepack.encode(msgProto, { seq: 1, kind: 3, lat: 32.08, lon: 34.78 });
// decode reads `kind`, then parses only the matching branch — flat object out
```

The tag can be an integer, a string, a bool or an **enum** — then the
branches are named by its options:

```js
['op', 'enum', ['put', 'del'], { variants: {
    put: [['key', 'string'], ['value', 'bytes']],
    del: [['key', 'string']]
}}]
```

Branch fields land in the same object as the parent's, so a name may appear
once across a struct and its branches (sibling branches may share one);
`compile` throws on a repeat.

### Named types & recursion

A schema can also be an object that names types. A name then works wherever
a struct does — as a field, an array item, a map value — and may refer to
itself or to other names:

```js
var Tree = {
    types: {
        Node: [['value', 'varint'], ['children', 'array', 'Node']]
    },
    fields: [['root', 'Node']]
};
litepack.encode(Tree, { root: { value: 1, children: [{ value: 2, children: [] }] } });

var Chat = {
    types: {
        User:    [['id', 'varint'], ['name', 'string']],
        Message: [['from', 'User'], ['text', 'string'], ['replyTo', 'Message?']]
    },
    fields: [['messages', 'array', 'Message'], ['members', 'map', 'string', 'User']]
};
```

* **Depth ceiling.** A recursive type nests at most `maxDepth` levels (100;
  set `{fields, types, maxDepth: 20}`), on encode and decode — a hostile
  message cannot recurse until the stack runs out, and a cyclic object
  (`a.children = [a]`) throws `LIMIT` instead of overflowing. Types that
  cannot reach themselves skip the check and cost exactly what an inline
  struct costs.
* **Finite only.** A type that contains itself through required fields alone
  (`Node: [['next', 'Node']]`) has no finite value; `compile` refuses it and
  names the cycle. Make one link optional (`'Node?'`) or an array.
* **Names** cannot be built-in types or codecs. `{fields: [...]}` with no
  types is the same schema as the plain list (same `schemaId`).

### Optional Fields

Any type takes a `?` suffix — or, the same thing spelled out, the option
`{optional: true}`. All optional fields in a struct share **one
varint bitmask** at the front — up to 7 optionals cost 1 byte of overhead
in total (14 cost 2), and each absent field costs nothing:

```js
['email', 'string?']
['age',   'uint8?']
['tags',  'array?', 'string']
```

Up to **52 optional fields** per struct (compile-time error beyond — split
into nested structs).

```js
['email', 'string', {optional: true}]    // = ['email', 'string?']
```

**Default values** — an options object as the last element of the def:

```js
['retries', 'varint?', {default: 3}]
['tags',    'array?', 'string', {default: []}]
```

On decode, an absent field gets the default instead of `undefined` (object
and array defaults are cloned per decode — no shared references). On
encode, absent still costs zero bytes. This is the painless way to evolve
schemas: add `['battery','uint8?',{default:100}]` and every old message
decodes with a sensible value — no `=== undefined` checks scattered
through your code.

### Limits (`min` / `max`)

The same options object bounds lengths, counts and numbers:

```js
['name',  'string',  {max: 64}]              // UTF-8 bytes, not characters
['tags',  'array', 'string', {max: 16}]      // item count
['meta',  'map', 'string', 'string', {max: 32}]
['ids',   'ascending', {max: 512}]
['times', 'deltas',  {max: 1000}]
['qty',   'varint',  {min: 1, max: 1000}]
['temp',  'float32', {min: -50, max: 60}]    // NaN is outside any range
['nick',  'string?', {max: 20, default: ''}] // with ? and default
```

Checked on encode **and** decode, in strict and extensible mode alike: a
peer's 10 MB string is refused by its length prefix, before it is decoded.
This is the defence against oversized messages from the network — the
schema says what a valid message is, and the decoder enforces it at the cost
of one comparison. Limits are part of the schema's `schemaId`; `default` is
not. Only lengths, counts and numbers take them — on `bool`, `fixed`,
`enum`, `struct` and the like, or on a fixed-count array, they would mean
nothing, so they are a compile error. Item limits for an
array of strings: wrap the item in a struct.

## 📚 API

### Core

#### `litepack.encode(schema, data)` → `Uint8Array`

**Throws** on anything it would otherwise have to guess: a missing required
field (at any depth — array items, variant branches, map values), a value of
the wrong JS type, a non-integer or out-of-range integer, unknown enum/set
values, a variant value with no branch, a `const` field holding another
value, a fixed-count array of another length, a bits subfield that does not
fit, a string with a lone surrogate, bytes that are not bytes, a value
outside its `{min, max}` or `chars`, nesting deeper than `maxDepth`. Missing
optional fields are free. Every error carries a `code` and a `path`
([Errors](#errors)).

#### `litepack.decode(schema, buf)` → `object`

Accepts `Uint8Array` or `ArrayBuffer`. **Throws** on malformed input —
truncation, declared lengths exceeding the buffer, varint bombs, impossible
array counts — and on any byte string `encode` would not have produced:
trailing bytes, padded varints, optional bits for fields the schema lacks,
an enum index or variant it does not know, a bool byte other than 0/1, a
NaN other than the one encode writes, invalid UTF-8, map keys out of order —
and on anything outside the schema's own rules: `{min, max}` limits, `chars`
alphabets, `maxDepth`. The error names the failing field (`err.path`) and
byte.

Options (third argument):

* `{extensible: true}` — for schemas that evolve (see Schema evolution):
  trailing bytes, unknown optional bits, enum indices, set bits and variants
  from a newer peer are tolerated.
* `{bigint: true}` — `uint64`/`int64` always decode to BigInt.
* `{copy: true}` — detach decoded bytes from the input buffer (below).

Pass `{copy: true}` as a third argument to detach decoded `bytes` /
`fixed` / `uuid` / `tail` views from the input buffer (one clone of the
input up front) — do this whenever you recycle network buffers:

```js
var msg = litepack.decode(proto, reusableBuf, { copy: true });
```

#### `litepack.tryDecode(schema, buf, opts?)` → `object | null`

Same as `decode`, but returns `null` on malformed input instead of
throwing. **The recommended call for network data:**

```js
var msg = litepack.tryDecode(proto, event.data);
if (!msg) return;              // hostile/corrupt input handled, done
```

### Precompiled handles

#### `litepack.compile(schema, options?)` → `{ encode, decode, tryDecode, byteLength }`

`schema` is a field list or an object schema (`{fields, types, maxDepth}`),
here and in every other function.

```js
var Cert = litepack.compile(certProto);
var buf  = Cert.encode(data);
var obj  = Cert.decode(buf);

var Presence = litepack.compile(presenceProto, { extensible: true });   // an evolving schema
```

Options given to `compile` (`extensible`, `bigint`) apply to every decode
through the handle.

Schemas used with `encode`/`decode` directly are compiled once and cached
via `WeakMap` — your schema array is never mutated and frozen schemas work.
`compile()` just makes call sites tidier. Either way: **define schemas once
at module level** and reuse the array — the cache is keyed by identity, so
re-parsing a schema from JSON on every call recompiles every time.

### Schema identity

#### `litepack.schemaId(schema)` → `number`

The wire carries no type information, so two peers holding different
schemas decode each other's messages into garbage — silently. `schemaId`
names a schema by what it means on the wire; exchange it in a handshake, or
store it beside saved data, and compare before decoding:

```js
litepack.schemaId([['id','varint'], ['name','string']]);   // 589299480
```

A number from 0 to 2^32−1: MurmurHash3 (32-bit, seed 0) of the schema's
canonical bytes. Fast (~0.2 µs to hash a typical schema, then cached) and
not cryptographic — it catches an accidental mismatch, which is its job.

Same schema meaning ⇔ same `schemaBytes` (two different schemas share a 32-bit id about once in 4 billion). Field names, types,
optional markers, enum/set options and their order, widths, lengths and
`{min, max}` limits all count; `{default}` options, alias spelling
(`timestamp`/`varint`) and the key order of a variants object do not.
Custom codecs count by name only — rename a codec when you change its
encoding. Definition: [SPEC.md](SPEC.md) §10.

#### `litepack.schemaBytes(schema)` → `Uint8Array`

The exact bytes `schemaId` hashes (`litepack-schema-v1\n` + the schema's
canonical JSON, UTF-8). For an id from any other hash, hash these:

```js
crypto.createHash('sha256').update(litepack.schemaBytes(schema)).digest();
```

### Sizing

#### `litepack.byteLength(schema, data)` → `number`

Exact encoded size without encoding — for frame budgets, preallocation,
and "will this fit in one packet?" checks.

### Errors

Every error litepack throws has a stable `err.code`, and — when it happened
inside a field — `err.path`; the message carries both for people:

```js
try { litepack.encode(txProto, tx); }
catch (e) {
    e.code;     // 'LIMIT'
    e.path;     // 'signers[1].ranges'
    e.message;  // "litepack: field 'ranges' — count 600 over max 512 ... (at signers[1].ranges)"
}
```

| code | when |
|---|---|
| `SCHEMA` | the schema itself is invalid (compile time) |
| `TYPE` | encode: a value of the wrong JS type (a `TypeError`) |
| `RANGE` | a number outside what its type holds |
| `MISSING` | encode: a required field or bits subfield is absent |
| `INVALID` | encode: a value the type cannot carry (wrong length, not ascending, const mismatch…) |
| `UNKNOWN` | an enum/set/variant value or optional bit the schema does not have |
| `LIMIT` | outside the field's `{min, max}` |
| `TRUNCATED` | decode: the input ends early (also `err.truncated === true`) |
| `TRAILING` | decode: bytes after the message |
| `MALFORMED` | decode: bytes no encoder writes (padding, order, non-minimal, bad UTF-8…) |
| `CODEC` | a custom codec encoded the same value differently twice |
| `BUFFER` | `encodeInto`: the target buffer is too small |

Paths look like `order.items[3].sku` for arrays and `meta["lang"]` for map
values. Tracking them costs nothing until something fails.

### Streaming & chaining

For frames that carry **more than one message**: a shared header followed
by a type-dependent body, or N messages packed into one send. See the
dedicated section below for the full story.

```js
var w = litepack.writer()               // chained-message builder
    .write(schemaA, dataA)              //   queue a message (chainable)
    .raw(preEncodedBytes);              //   splice raw bytes (signatures, blobs)
w.byteLength();                         //   total so far, without encoding
w.bytes();                              //   → one exactly-sized Uint8Array

var r = litepack.reader(buf, opts?);    // sequential cursor; opts as for decode
r.read(schema)                          //   decode next message + advance (throws)
r.tryRead(schema)                       //   null on malformed, cursor NOT advanced
r.peek(schema)                          //   decode without advancing
r.skip(n)                               //   jump over foreign bytes
r.remaining(); r.eof(); r.offset;

litepack.decodeFrom(schema, buf, offset, opts?) // → { value, bytesRead }
litepack.encodeInto(schema, data, buf, offset)  // → bytes written (throws if no fit)
litepack.concat([buf1, buf2, ...])              // → one Uint8Array, single allocation
```

### TypeScript

`litepack.d.ts` (TypeScript 5+) derives the data type from the schema —
declare it `as const`, or write it inline in the call:

```ts
const User = [['id', 'varint'], ['name', 'string'], ['email', 'string?']] as const;

litepack.encode(User, { id: 1, name: 'Aviv' });      // ✓
litepack.encode(User, { id: 1 });                    // ✗ Property 'name' is missing
const u = litepack.decode(User, buf);                // { id: number; name: string; email?: string }

type UserData = litepack.Infer<typeof User>;         // the same type, by name
```

Every type is covered: enums and sets become unions of their names, `bits`
an object of its subfields, structs, arrays and maps nest, `const` fields
are optional, variants become a union of branches (`if (m.kind === 2)
m.lat` narrows), and named types resolve — recursion included. A schema that
is not `as const` (built at runtime, or typed `litepack.Field[]`) gives
`Record<string, any>`, as in 1.x. Errors are typed `litepack.LitepackError`
(`code`, `path`, `truncated`).

### Version

`litepack.version` — the library version string (`'2.0.0'`).

### Custom codecs

#### `litepack.codec(name, { encode, decode, estimateSize? })`

Register any encoder as a field type:

```js
var cbor = require('cbor-x');
litepack.codec('cbor', {
    encode: function(val) { return cbor.encode(val); },
    decode: function(buf) { return cbor.decode(buf); }
});

var schema = [['id', 'uint32'], ['payload', 'cbor']];
```

`encode` must be deterministic (same value → same bytes). litepack detects
a size mismatch between the sizing pass and the writing pass and throws,
rather than emitting a corrupted buffer. Provide `estimateSize(val)` to
skip the extra sizing encode for large values. Built-in type names
(`string`, `varint`, `json`, …) are reserved: 1.x let `codec('string', …)`
silently replace the string type in every schema.

## 🔗 Streaming & chaining: multiple messages, one buffer

`decode()` answers *"what is in this buffer"*. `reader`/`writer` answer
*"what is **next** in this buffer"* — which is what real protocols need.

### Recipe: shared header + per-type body

Every message in your protocol starts the same way; the rest depends on
the type. Instead of copying the header fields into every schema:

```js
// Define the header ONCE
var headerProto = [
    ['type', 'uint8'],
    ['sub',  'uint8']
];

// Bodies are separate, small schemas
var scalarBody = [['subjectPeerId', 'varint'], ['value', 'varint']];
var listBody   = [['subjectPeerId', 'varint'], ['value', 'array', 'varint']];

// ── Sending ──
var frame = litepack.writer()
    .write(headerProto, { type: MSG.PEER_INFO, sub: SUB.BATTERY })
    .write(scalarBody,  { subjectPeerId: peerId, value: 88 })
    .bytes();

// ── Receiving ──
var r = litepack.reader(frame);
var head = r.read(headerProto);              // decoded, not byte-peeked
if (head.type !== MSG.PEER_INFO) return;
var body = r.read(head.sub === SUB.LIST ? listBody : scalarBody);
```

**Wire guarantee:** chaining `headerProto` then `bodyProto` produces
**byte-identical** output to a single merged schema with the same fields in
the same order (as long as each part keeps its own optional fields). And
since schemas are plain arrays, `headerProto.concat(scalarBody)` *is* that
merged schema — old code using merged protos and new code using chained
reads interoperate freely.

### Recipe: batching N updates into one send

Sending 50 tiny WebSocket messages costs 50 frames of transport overhead.
Pack them:

```js
var updateProto = [['entityId', 'varint'], ['x', 'svarint'], ['y', 'svarint']];

// sender — one allocation, one send
var w = litepack.writer();
for (var i = 0; i < updates.length; i++) w.write(updateProto, updates[i]);
socket.send(w.bytes());

// receiver — read until the frame is exhausted
var r = litepack.reader(event.data);
while (!r.eof()) {
    var u = r.tryRead(updateProto);
    if (!u) break;               // malformed remainder — stop cleanly
    applyUpdate(u);
}
```

### Recipe: raw TCP streams (no framing)

Over raw sockets, bytes arrive in arbitrary chunks — a message may be
split across packets. Decode errors caused by *truncation* carry
`err.truncated === true`, meaning "more bytes might complete this";
*malformed* errors don't, meaning "drop it":

```js
var acc = new Uint8Array(0);

socket.on('data', function(chunk) {
    acc = litepack.concat([acc, chunk]);
    var offset = 0;
    while (offset < acc.length) {
        try {
            var r = litepack.decodeFrom(msgProto, acc, offset);
            handleMessage(r.value);
            offset += r.bytesRead;
        } catch (e) {
            if (e.truncated) break;      // partial message — wait for more bytes
            throw e;                     // malformed — protocol error, disconnect
        }
    }
    acc = acc.subarray(offset);          // keep only the unconsumed remainder
    if (acc.length > MAX_FRAME) socket.destroy();   // cap growth — don't let a
});                                                  // hostile peer buffer forever
```

### Recipe: length-aware parsing with `decodeFrom`

When you need manual control (index building, seeking through a file of
packed records):

```js
var rec = litepack.decodeFrom(recordProto, fileBytes, offset);
// rec.value     — the decoded object
// rec.bytesRead — where the next record starts
offset += rec.bytesRead;
```

## 🌍 Real-world examples

### P2P presence updates

A peer announces its battery level to the swarm. As JSON:
`{"type":64,"sub":6,"subjectPeerId":918273645,"value":88}` — **56 bytes**.

```js
var peerInfoProto = [
    ['type',          'uint8'],
    ['sub',           'uint8'],
    ['subjectPeerId', 'varint'],
    ['value',         'varint']
];
litepack.encode(peerInfoProto, { type:64, sub:6, subjectPeerId:918273645, value:88 });
// → 8 bytes (86% smaller). At 10 updates/sec × 50 peers, that's the
//   difference between 28 KB/s and 4 KB/s of presence traffic.
```

### Multiplayer game state

```js
var stateProto = [
    ['tick',    'varint'],
    ['players', 'array', 'struct', [
        ['id',    'varint'],
        ['x',     'svarint'],       // deltas go negative — svarint keeps them 1-2 bytes
        ['y',     'svarint'],
        ['flags', 'bits', [['alive',1], ['team',2], ['weapon',4], ['anim',5]]]
    ]]
];
// 8 players ≈ 44 bytes/tick vs ~610 as JSON. At 30 ticks/sec: 1.3 KB/s vs 18 KB/s.
```

### IoT sensor batch

```js
var batchProto = [
    ['deviceId', 'uint32'],
    ['baseTime', 'varint'],
    ['readings', 'array', 'struct', [
        ['dt',    'varint'],        // ms since previous reading — tiny varints
        ['temp',  'svarint'],       // tenths of a degree, signed
        ['state', 'bits', [['ok',1], ['battery',7]]]
    ]],
    ['signature', 'fixed', 64]      // exactly 64 bytes, no prefix
];
```

### Signed certificates (deterministic bytes)

`JSON.stringify` output depends on key insertion order — the same cert can
hash differently on the signer and the verifier. litepack output depends
only on the schema:

```js
var certSignProto = [
    ['version',   'uint8'],
    ['timestamp', 'varint'],
    ['issuerId',  'varint'],
    ['publicKey', 'bytes'],
    ['subjectId', 'bytes']
];

var signBytes = litepack.encode(certSignProto, cert);   // throws MISSING on a hole
var signature = await sign(sha256(signBytes));
// The verifier rebuilds signBytes from the received cert with the SAME
// schema — guaranteed identical bytes.
```

### Message families with variants

```js
var wireProto = [
    ['msgType', 'uint8', { variants: {
        '1': [['roomId', 'varint'], ['text', 'string']],
        '2': [['roomId', 'varint'], ['imageId', 'varint'], ['thumb', 'bytes']],
        '3': [['peerId', 'varint']]           // typing indicator
    }}]
];

var msg = litepack.tryDecode(wireProto, packet);
if (!msg) return;
switch (msg.msgType) { /* fields of the matching branch are on msg */ }
```

## 🧬 Schema evolution

By default a schema is **closed**: decode accepts exactly the bytes encode
writes for that schema. That is what you want for anything hashed or signed.
A schema that will grow while old and new peers talk to each other declares
it, and follows two rules.

**1. Give it an optional field from its first version.** All optional
fields share one bitmask at the *start* of the message. A schema with no
optional field has no bitmask, so adding the first one later inserts a byte
in front of every field — and an old reader misreads all of them. (1.x's own
example here did exactly that, silently: `id: 4` came back as `1`.)

**2. Add new fields at the end, as optional fields, and decode with
`{extensible: true}`.**

```js
// v1                                  // v2
[['id',  'varint'],                    [['id',  'varint'],
 ['name','string'],                     ['name','string'],
 ['ext', 'varint?']]   // reserved      ['ext', 'varint?'],
                                        ['battery','uint8?']]   // ← new, optional, last

var V1 = litepack.compile(v1, { extensible: true });
```

* Old decoder + new message → reads its known fields; the unknown optional
  bit and the trailing bytes are tolerated. Works.
* New decoder + old message → `battery` bit absent → `undefined` (or its
  default). Works.
* `{extensible: true}` on a schema without any optional field **throws** —
  it is rule 1, checked for you.

In extensible mode an enum index, set bit or variant value the reader does
not know comes back raw (`_unknownVariant: true` for variants) instead of
throwing.

**❌ Breaking — never do these to a live protocol:**

* Insert/remove/reorder fields anywhere but the end.
* Change a field's type.
* Add a *required* field (old messages fail to decode as truncated).
* Reorder `enum`/`set` option lists (indices are the wire values — append
  new options at the end only).
* Change a `chars` alphabet (indices are the characters) or tighten
  `{min, max}` / `maxDepth` (old messages may now be rejected). Loosening a
  limit is safe for new readers, but old readers still enforce the old one.

For bigger changes, bump a version discriminator and use **variants** to
carry both shapes during the transition.

## 🛡 Robustness model

Two trust levels, by design:

| Direction | Policy | Why |
|---|---|---|
| **encode** (your data) | strict — throws on typos, negatives, overflow, wrong-length `fixed`/`uuid`, misplaced `tail` | a bug in *your* code should explode in dev, not ship corrupted bytes |
| **decode** (their data) | defensive and canonical — bounded, validated; throws (or `tryDecode` → `null`) on anything malformed or on any second encoding of a valid message | wire input is attacker-controlled; garbage in must never mean garbage out, OOM, or a CPU spin — and one message must never have two byte forms (two ids, two signatures) |

Decode hard limits: varints capped at 8 bytes; array counts validated
against remaining buffer bytes **before** allocation; every declared length
checked before use; recursive types nest at most `maxDepth` levels;
truncation detected per-field with the field path in the error.

**The canonical guarantee:** for every schema, if `decode(schema, bytes)`
succeeds then `encode(schema, result)` returns exactly `bytes`. The test
suite checks it on 10,000 corrupted messages per run.

**Oversized input:** give every string, bytes, array and map that comes
from the network a `{max}` — decode then refuses an oversized field by its
length prefix, before reading it.

**Hostile names:** a map key `"__proto__"` from the wire is stored as an
ordinary own key (1.x let it replace the object's prototype), and schemas
cannot name a field `__proto__`.

**Other languages:** [SPEC.md](SPEC.md) defines the wire format byte by
byte, and `spec/vectors.json` holds 170+ vectors (valid messages, messages
that must be rejected, values that must be refused, schema ids). A port
conforms when it passes them all.

**Defaults:** where safety costs speed, speed is the default and safety an
option (`{copy:true}`, `{bigint:true}`); where it costs nothing, safety is
the default.

## ⚡ Performance

Measured with `node bench.js` on Node 22 (best of 5 runs; one machine —
compare builds on yours with `node bench.js <old> <new>`):

| Message | encode | decode |
|---|---|---|
| mixed (ints + string + array), 28 B | 3.9M ops/s | 5.7M ops/s |
| enum + set, 3 B | 6.2M ops/s | 11.7M ops/s |
| optionals (2 of 4) + bits, 11 B | 2.7M ops/s | 5.8M ops/s |
| 5 structs with nested arrays, 31 B | 950K ops/s | 2.1M ops/s |
| transaction-like (fixed 32 + arrays of structs), 80 B | 810K ops/s | 2.3M ops/s |
| map, 5 string keys, 35 B | 2.0M ops/s | 2.8M ops/s |

Chaining parts with `writer` costs nothing against one merged schema, and
neither do error paths or named types that do not recurse. A `{min, max}`
limit costs one comparison; a `chars` string decodes ~15% slower than a
plain one.

2.0 against 1.2.2 on the same machine (`node bench.js litepack-1.2.2.js
litepack.js`): the strict checks are within measurement noise (±10%) on
every message type, and short-string decoding is faster (an ASCII fast
path). Two costs remain, both only where the work is real: an **unsorted**
map is sorted on encode (≈ −33% for a 5-key map; sorted input costs
nothing), and `{bigint:true}` decoding (≈ −25-50%, opt-in).

Under the hood: schemas compile once to closures (cached by identity),
string sizing scans without allocating, UTF-8 encodes straight into the
output buffer (`TextEncoder.encodeInto`), enum/set lookups are prebuilt
maps, buffers are allocated exactly once per encode.

## 📊 Size comparison

Bytes, same data in each format — reproduce with `node bench-sizes.js`
(needs `npm i protobufjs @msgpack/msgpack`):

| Message | JSON | MessagePack | protobuf | litepack |
|---|---|---|---|---|
| User record (enum, set, optional) | 112 | 85 | 40 | **35** |
| Game state, 10 players (`bits`) | 589 | 393 | 190 | **111** |
| 20 sensor readings, one struct each | 850 | 606 | 314 | **221** |
| the same, as `deltas` + `bitset` columns | 850 | 606 | 314 | **71** |
| 64 booleans (`bitset`) | 369 | 70 | 66 | **9** |
| AddressBook (protobuf tutorial, 3 people) | 354 | 263 | 143 | **125** |
| MediaContent (jvm-serializers benchmark) | 468 | 379 | 235 | **217** |

Text-heavy messages gain least (MediaContent is 82% strings); `chars`
alphabets cut that further when the text has a known alphabet.

## 💡 Schema as JSON

Schemas are plain arrays — store them in JSON files, share between server
and client:

```json
[
  ["id",      "varint"],
  ["name",    "string"],
  ["status",  "enum",  ["active", "inactive", "banned"]],
  ["streams", "array", "struct", [["streamId", "varint"], ["toPeers", "array", "varint"]]]
]
```

```js
var schema = JSON.parse(fs.readFileSync('schema.json'));   // parse ONCE
litepack.encode(schema, data);                             // reuse the array
```

Object schemas (`{"fields": [...], "types": {...}}`) are JSON too. Every
option is JSON except a `BigInt` limit; a schema built in code can be
saved with `JSON.stringify` and used as-is.

## 🔁 Moving from Protocol Buffers

`litepack-proto.js` (separate file, no dependencies) turns a `.proto` into a
litepack schema plus converters for the data:

```js
var protobuf = require('protobufjs');               // only to read the .proto
var lpProto  = require('./litepack-proto.js');

var root = protobuf.loadSync('addressbook.proto');
var m = lpProto.fromProto(root, 'tutorial.AddressBook');

m.schema;                       // {fields, types} — save it as JSON, use it anywhere
m.notes;                        // every mapping that is not one-to-one, in words

// data: a protobufjs object ↔ litepack bytes
var Book  = root.lookupType('tutorial.AddressBook');
var obj   = Book.toObject(Book.decode(protobufBytes));
var bytes = m.encode(litepack, obj);                 // = litepack.encode(m.schema, m.toLitepack(obj))
var back  = Book.fromObject(m.decode(litepack, bytes));
```

| protobuf | litepack |
|---|---|
| fields | in field-number order — new numbers land at the end, litepack's evolution rule |
| `int32`, `sint32` | `svarint` (protobuf spends 10 bytes on a negative `int32`) |
| `uint32` | `varint` |
| `int64`, `sint64`, `uint64` | `svarint` / `varint` — up to ±2^52 / 2^53; `{wide64: true}` for the full range (8 bytes) |
| `fixed32/64`, `sfixed32/64` | `uint32/64`, `int32/64` |
| `double`, `float`, `bool`, `string`, `bytes` | `float64`, `float32`, `bool`, `string`, `bytes` |
| message | a named type — recursion included |
| enum 0..n-1 | `enum` (by name) |
| enum with gaps, negatives or aliases | `svarint` (the number); the converters translate names |
| `repeated`, `map<K,V>` | `array`, `map` — optional, empty by default |
| proto3 scalar (implicit presence) | optional with the zero `default` — absent costs nothing, as in protobuf |
| `optional`, message fields, proto2 `optional` | optional (presence kept: `0` and absent stay different) |
| `required` | required |
| `oneof x { a; b; }` | a tag field `x`: `enum ['', 'a', 'b']` with one variant per member (`''` = none) |

Not carried over: extensions and groups (an error names them). The bytes are
not protobuf's — both sides switch, or a bridge decodes one and encodes the
other. Tested against protobufjs: every scalar type, enums dense and sparse,
maps (string, integer and bool keys; message and enum values), `oneof`,
`optional`, recursion, proto2 `required`/defaults, and 500 random messages
(28% smaller than protobuf); the tutorial's AddressBook goes from 143 to 125
bytes, the MediaContent benchmark from 235 to 217.

## 🔄 Migrating from 1.x to 2.0

The **wire format is unchanged** for valid data: every message 1.2.2
encodes, 2.0 encodes to the same bytes (tested on 2,000 random messages) —
with two exceptions:

* **maps** write their keys in sorted order;
* **bits fields wider than 31 bits** are laid out like the narrower ones
  (padding in the top bits of the first byte; 1.x put it in the low bits of
  the last byte, so adding a subfield that crossed 31 bits moved every
  existing one). Fields of up to 31 bits are unchanged.

What changes is what is *accepted*:

* **encode throws where 1.x guessed:** missing required fields (were zero
  values), wrong JS types (`'5'` or `5n` as `varint` were `0`), non-integers
  (were floored/rounded), out-of-range signed ints (were masked), `uint64`
  Numbers beyond 2^53 (were rounded), bits values too wide (were masked) or
  missing (were 0), unknown variant values (branch fields were dropped), a
  `const` field holding another value, fixed-count arrays of another length
  (were padded with zeros), bytes given as other typed arrays.
* **decode throws where 1.x accepted:** trailing bytes, padded varints,
  unknown optional bits / enum indices / set bits / variants — all allowed
  again with `{extensible: true}` — and, always: bool bytes other than 0/1,
  non-canonical NaN, invalid UTF-8 (was replaced by U+FFFD), map keys out of
  order or repeated, non-zero bits padding.
* **`uint64`/`int64` decode to Number**, and throw beyond 2^53; use
  `{bigint: true}` for BigInt (1.x mixed the two by value).
* **A leading U+FEFF in a string is kept** (1.x's decoder dropped it).
* **`codec()` refuses built-in type names.**
* **`compile` refuses** a field name used twice in a struct and its variant
  branches (1.x encoded both and decoded the second), repeated enum/set
  options or bits subfield names, and the name `__proto__`.
* **`assertComplete` is removed** — `encode` now throws on everything it
  checked; call `encode` and drop the bytes if you only want the check.
* **Errors have `err.code` and `err.path`** (see [Errors](#errors)).
* **Variants and fixed array counts move into the options object:**
  `['kind','uint8',{'1':[...]}]` → `['kind','uint8',{variants:{'1':[...]}}]`
  and `['rgb','array','uint8',3]` → `['rgb','array','uint8',{count:3}]`. The
  old forms are compile errors that say what to write. Schema ids and wire
  bytes are unchanged.
* **Unknown options are errors** (were ignored), and so is a definition on a
  type that takes none (`['a','varint',5]`).
* New: `{optional: true}` (same as `?`), enum-tagged variants, arrays of `fixed` items, `compile(schema, options)`, `tryDecode` on
  compiled handles, `{extensible}`, `{bigint}`, `schemaId`,
  `schemaBytes`, named and recursive types (`{fields, types, maxDepth}`),
  the `ascending`, `deltas` and `bitset` types, `{min, max}` limits,
  [SPEC.md](SPEC.md) with test vectors.

## 🔄 Migrating from 1.0

The **wire format is unchanged** — 1.0 and 1.1 peers interoperate freely.
Behavior changes to be aware of:

* `decode` now **throws** on malformed/truncated input (previously returned
  silently wrong data). Wrap untrusted decodes with `tryDecode`.
* `encode` now **throws** on unknown enum/set values, negative `varint`,
  and `varint` above 2^53-1 (previously silently encoded a different value).
* More than 31 optional fields / set options previously corrupted data
  silently; now supported correctly up to 52, compile-time error beyond.
* Bitfields totalling more than 32 bits previously corrupted silently; now
  packed correctly.
* `tail` outside the last top-level position is now a compile-time error
  (previously corrupted silently).
* (1.2.2) `fixed` and `uuid` throw on a value of the wrong length or that is
  not bytes (previously cut, zero-padded, or — for a string — written as
  zeros, silently).
* New types: `svarint`, `int64`, `json`, `const`, `map`, `uuid`,
  `timestamp`. New API: `compile`, `tryDecode`, `byteLength`,
  `reader`, `writer`, `decodeFrom`, `encodeInto`,
  `concat`, `{copy:true}` decode option, `{default:…}` field option,
  `err.truncated` for stream parsing.

## 📁 Project Structure

```
litepack.js             — single file, UMD, zero dependencies
litepack.d.ts           — TypeScript declarations: the data type inferred from the schema (TS 5+)
types-test/             — type tests (npx tsc -p types-test)
litepack.test.js        — core test suite (1.x; expectations of coercion need updating)
litepack.chain.test.js  — streaming/composition test suite
litepack.v2.test.js     — 2.0: strict encode/decode, options, wire compatibility, canonical fuzz
litepack-proto.js       — .proto → litepack schema + data converters (no dependencies)
proto-test/             — its tests against protobufjs (npm i protobufjs; node --test proto-test/litepack-proto.test.js)
SPEC.md                 — the wire format, byte by byte (for ports to other languages)
spec/vectors.json       — test vectors: valid, must-reject, must-refuse, schema ids
spec/vectors.test.js    — runs the vectors against litepack.js (node --test spec/vectors.test.js)
spec/gen-vectors.js     — regenerates vectors.json (asserts the hand-written hex first)
bench.js                — node bench.js <old build> <new build>
bench-sizes.js          — the size comparison table (JSON, MessagePack, protobuf, litepack)
litepack-tool.html      — interactive schema builder & tester
```

## ⚠️ Common pitfalls

The six mistakes everyone makes once — read this and make zero:

**1. Field order IS the protocol.** There are no field names or tags on the
wire. If the sender's schema says `[id, name]` and the receiver's says
`[name, id]`, you get garbage — both sides must use the *identical* schema.
Share it as a module or JSON file; never retype it — and compare
`litepack.schemaId(schema)` in your handshake to catch a mismatch.

**2. Decoded `bytes`/`fixed`/`uuid`/`tail` are views.** They point into
the input buffer. If you recycle that buffer (common with sockets), your
decoded values silently change. Recycling? → `decode(proto, buf, {copy:true})`.

**3. Reparsing schemas kills the cache.** Compilation is cached by array
*identity*. `JSON.parse(schemaText)` inside a hot loop creates a new array
every call → recompiles every call. Parse once at module level.

**4. `varint` is unsigned.** `-1` throws (on purpose). Deltas and
coordinates that go negative → `svarint`.

**5. Untrusted input goes through `tryDecode`.** Plain `decode` throws on
malformed bytes — correct for your own data, but an unhandled exception in
a socket handler if a hostile peer sends garbage. `tryDecode` → `null` →
`return`.

**6. A schema that will evolve needs an optional field from day one.** The
optional bitmask sits at the start of the message; adding the *first*
optional field later shifts every field for old readers. Reserve one
(`['ext','varint?']`) and decode with `{extensible: true}` — see Schema
evolution.

## 🥊 How does it compare?

An honest map of the landscape:

| | Approach | Strong at | Weak at (vs litepack) |
|---|---|---|---|
| **litepack** | schema in code, single file | tiny messages, zero build step, JSON-storable schemas, `bits`/`set`/`bitset`/`deltas`/`tail`/variants, recursion, built-in validation (`min`/`max`/`chars`), canonical bytes | ecosystem size, cross-language ports (a [SPEC](SPEC.md) and vectors exist) |
| **Protocol Buffers** | `.proto` files + codegen | huge ecosystem, every language, field-tag evolution (can delete fields), keeps unknown fields | heavy toolchain; build step or a large runtime; not canonical; no validation or bitfields |
| **MessagePack / CBOR** | schemaless | zero setup, any shape | sends key names in **every** message — 2-3× larger on small structured messages |
| **FlatBuffers** | schema + zero-copy access | reading giant buffers without deserializing | complex API, codegen required, larger output for small messages |
| **Avro** | schema as JSON | schema resolution between versions, big-data tooling | JVM-centric ecosystem, heavier runtime |

**Where litepack wins:** small, frequent, structured messages — the
per-message overhead of key names (MessagePack) or field tags (protobuf)
dominates exactly there. One file, no build step, runs in a Service
Worker, schemas are plain arrays you can ship as JSON, and the output is
deterministic enough to sign.

**Where to pick something else:** a public API consumed by parties you
don't control (protobuf's tag-based evolution is more forgiving), truly
schemaless payloads (CBOR), or random access into multi-megabyte buffers
(FlatBuffers).

## 🤝 Contributing

Pull requests are welcome!
Please open an issue before submitting major changes.

## 📜 License

**MIT**
