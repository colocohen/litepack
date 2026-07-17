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
40 08 CD 8F E5 B5 03 07 70 65 65 72 2D 78 31 05 01 16 CD 02 DC 22 A3 B2 03
```

The schema lives in your code (or a shared JSON file), so key names never
travel. Integers use variable-length encoding — small numbers cost 1 byte.
Enums become indices. Flags pack into bits. **70–90% smaller than JSON** on
typical structured messages.

### When to use it

* 🔌 **Real-time messaging** — WebSocket / WebRTC / TCP protocols where
  messages are small and frequent (presence updates, game state, signaling,
  telemetry). This is where per-message overhead dominates.
* 📱 **Mobile & metered connections** — every byte is battery and quota.
* 💾 **Compact storage** — millions of small records in IndexedDB, Redis,
  or files.
* ✍️ **Canonical bytes for signing** — deterministic output, unlike
  `JSON.stringify` (which depends on key order).

### When NOT to use it

* Human-readable configs and logs — use JSON.
* Large repetitive payloads — litepack is compact *encoding*, not
  *compression*; run gzip/deflate on top (or instead) for multi-KB blobs.
* Schemaless data — if you truly can't know the shape ahead of time,
  use the built-in `json` field type as an escape hatch, or CBOR/MsgPack.

## 📦 Installation

```
npm i litepack
```

Or just drop `litepack.js` into your project — it's a single UMD file that
works with `require`, `import`, or a `<script>` tag, in Node.js, browsers,
Service Workers, Bun and Deno. TypeScript declarations (`litepack.d.ts`)
give you autocomplete even in plain-JS projects.

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
// → Uint8Array(29)   (~70 bytes as JSON)

// 3. Decode
var user = litepack.decode(userProto, buf);
// → { id: 12345, name: 'Aviv', email: 'aviv@example.com', age: 30 }

// 4. Decoding bytes from the network? Use tryDecode — it never throws:
var msg = litepack.tryDecode(userProto, untrustedBytes);
if (!msg) return;   // malformed / truncated / hostile input — dropped
```

## 🔍 What the bytes look like

Understanding the wire format takes one example. Take this schema and data:

```js
var proto = [
    ['id',    'varint'],
    ['flags', 'bits', [['active',1], ['mode',3]]],
    ['name',  'string'],
    ['email', 'string?']
];
litepack.encode(proto, { id: 300, name: 'Dan' });   // email omitted
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

### Integers

```js
['level',    'uint8']       // 0..255                    (1 byte)
['temp',     'int8']        // -128..127                 (1 byte)
['port',     'uint16']      // 0..65535                  (2 bytes)
['altitude', 'int16']       // -32768..32767             (2 bytes)
['color',    'uint32']      // 0..4294967295             (4 bytes)
['time',     'int32']       // signed 32-bit             (4 bytes)
['filesize', 'uint64']      // 0..2^64                   (8 bytes, BigInt above 2^53)
['balance',  'int64']       // signed 64-bit             (8 bytes, BigInt beyond ±2^53)
['count',    'varint']      // unsigned, variable size   (1 byte for 0-127, 2 for 128-16383…)
['delta',    'svarint']     // SIGNED varint (zigzag)    (-1 → 1 byte; small magnitudes stay small)
```

**Choosing between them:** `varint` for counts, ids, timestamps — anything
usually small but occasionally big. Fixed-width types (`uint32` etc.) when
the value is uniformly distributed (hashes, colors) — a varint would
*cost* more there. `svarint` for deltas and coordinates that go negative.

> ⚠️ `varint` is unsigned by design — encoding a negative value **throws**
> (use `svarint`). Values above 2^53-1 also throw (use `uint64`).

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

> `tail` must be the **last field of a top-level schema**. Inside a nested
> struct or array item there is no defined end — the compiler throws with a
> clear message (use `bytes` there instead).
>
> ⚠️ On decode, `bytes` / `fixed` / `tail` return **views** into the input
> buffer (zero-copy, fast). If you reuse or mutate the network buffer after
> decoding, copy first: `new Uint8Array(msg.payload)`.

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
with the wrong msgcode is rejected before you look at it. Any simple base
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
* A raw non-negative **number** passes through an enum untouched — forward
  compatibility for values defined by a newer peer. Decoding an
  out-of-range index likewise returns the raw number.
* `set` supports up to **52 options** (varint bitmask limit) — more than
  that is a compile-time error, not silent corruption.

### Bits (Bitfield Packing)

```js
['flags', 'bits', [
    ['active',  1],     // 1 bit  — 0 or 1
    ['mode',    3],     // 3 bits — 0 to 7
    ['quality', 4]      // 4 bits — 0 to 15
]]
// 8 bits total = exactly 1 byte on the wire

litepack.encode(s, { flags: { active: 1, mode: 5, quality: 12 } });
```

Perfect for sensor readings, permissions, and protocol flags. Subfield
widths are 1–32 bits each; the total can exceed 32 bits — it packs
correctly across as many bytes as needed.

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
['rgb',    'array', 'uint8', 3]          // fixed count — no prefix, saves a byte
['tags',   'array', 'string']
['roles',  'array', 'enum', ['admin', 'user', 'guest']]

// Array of structs — fully supported, including nested arrays inside:
['streams', 'array', 'struct', [
    ['streamId', 'varint'],
    ['fromPeer', 'varint'],
    ['toPeers',  'array', 'varint']
]]

// Array of structs with fixed count
['points', 'array', 'struct', [['x','float32'], ['y','float32']], 2]
```

There is **no need** to pre-encode struct entries into an `array` of
`bytes` — arrays of structs (with strings, optionals, enums, bits, and
nested arrays inside) work natively, and cost one length prefix *less* per
entry than the manual wrapping trick.

### Variants (Tagged Union)

Different fields depending on a discriminator — one schema for a whole
message family:

```js
var msgProto = [
    ['seq',  'varint'],
    ['kind', 'uint8', {
        '1': [['text', 'string']],                                   // chat
        '2': [['width', 'uint16'], ['height', 'uint16'], ['data', 'bytes']],  // image
        '3': [['lat', 'float64'], ['lon', 'float64']]                // location
    }]
];

litepack.encode(msgProto, { seq: 1, kind: 3, lat: 32.08, lon: 34.78 });
// decode reads `kind`, then parses only the matching branch — flat object out
```

### Optional Fields

Any type takes a `?` suffix. All optional fields in a struct share **one
varint bitmask** at the front — 8 optionals cost 1 byte of overhead total,
and each absent field costs nothing:

```js
['email', 'string?']
['age',   'uint8?']
['tags',  'array?', 'string']
```

Up to **52 optional fields** per struct (compile-time error beyond — split
into nested structs).

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

## 📚 API

### Core

#### `litepack.encode(schema, data)` → `Uint8Array`

**Throws** on invalid data: unknown enum/set values, negative `varint`,
values above 2^53-1, misplaced `tail`. Missing optional fields are free;
missing required scalars encode as zero-values (see `assertComplete` to
forbid that).

#### `litepack.decode(schema, buf)` → `object`

Accepts `Uint8Array` or `ArrayBuffer`. **Throws** on malformed input —
truncation, declared lengths exceeding the buffer, varint bombs, impossible
array counts — with the failing field named in the error. Trailing bytes
after the last field are ignored (that's what makes schema evolution work;
see below).

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

#### `litepack.compile(schema)` → `{ encode, decode, byteLength }`

```js
var Cert = litepack.compile(certProto);
var buf  = Cert.encode(data);
var obj  = Cert.decode(buf);
```

Schemas used with `encode`/`decode` directly are compiled once and cached
via `WeakMap` — your schema array is never mutated and frozen schemas work.
`compile()` just makes call sites tidier. Either way: **define schemas once
at module level** and reuse the array — the cache is keyed by identity, so
re-parsing a schema from JSON on every call recompiles every time.

### Sizing & validation

#### `litepack.byteLength(schema, data)` → `number`

Exact encoded size without encoding — for frame budgets, preallocation,
and "will this fit in one packet?" checks.

#### `litepack.assertComplete(schema, data)` → `true | throws`

Throws if any **non-optional** field is `undefined`/`null`, recursing into
structs, with the full field path in the message. Essential before
producing canonical/signed bytes, where "missing field silently encodes as
empty" would let a broken record produce a valid-looking signature:

```js
litepack.assertComplete(certSignProto, cert);
// → Error: litepack: missing required field 'publicKey'
var signBytes = litepack.encode(certSignProto, cert);
```

### Streaming & chaining

For frames that carry **more than one message**: a shared header followed
by a type-dependent body, or N messages packed into one send. See the
dedicated section below for the full story.

```js
litepack.writer()                       // chained-message builder
    .write(schemaA, dataA)              //   queue a message (chainable)
    .raw(preEncodedBytes)               //   splice raw bytes (signatures, blobs)
    .byteLength()                       //   total so far, without encoding
    .bytes()                            //   → one exactly-sized Uint8Array

var r = litepack.reader(buf);           // sequential cursor
r.read(schema)                          //   decode next message + advance (throws)
r.tryRead(schema)                       //   null on malformed, cursor NOT advanced
r.peek(schema)                          //   decode without advancing
r.skip(n)                               //   jump over foreign bytes
r.remaining(); r.eof(); r.offset;

litepack.decodeFrom(schema, buf, offset)        // → { value, bytesRead }
litepack.encodeInto(schema, data, buf, offset)  // → bytes written (throws if no fit)
litepack.concat([buf1, buf2, ...])              // → one Uint8Array, single allocation
```

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
skip the extra sizing encode for large values.

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
`{"type":64,"sub":6,"subjectPeerId":918273645,"value":88}` — **57 bytes**.

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
// 8 players ≈ 45 bytes/tick vs ~450 as JSON. At 30 ticks/sec: 1.3 KB/s vs 13 KB/s.
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

litepack.assertComplete(certSignProto, cert);      // refuse to sign a hole
var signBytes = litepack.encode(certSignProto, cert);
var signature = await sign(sha256(signBytes));
// The verifier rebuilds signBytes from the received cert with the SAME
// schema — guaranteed identical bytes.
```

### Message families with variants

```js
var wireProto = [
    ['msgType', 'uint8', {
        '1': [['roomId', 'varint'], ['text', 'string']],
        '2': [['roomId', 'varint'], ['imageId', 'varint'], ['thumb', 'bytes']],
        '3': [['peerId', 'varint']]           // typing indicator
    }]
];

var msg = litepack.tryDecode(wireProto, packet);
if (!msg) return;
switch (msg.msgType) { /* fields of the matching branch are on msg */ }
```

## 🧬 Schema evolution

Protocols change. The rules for staying compatible are simple and
mechanical:

**✅ Safe — add optional fields at the END:**

```js
// v1                                  // v2
[['id','varint'],                      [['id','varint'],
 ['name','string']]                     ['name','string'],
                                        ['battery','uint8?']]   // ← new, optional, last
```

* Old decoder + new message → reads its known fields, **ignores the
  trailing bytes**. Works.
* New decoder + old message → `battery` bit absent in the bitmask →
  `undefined`. Works.

**❌ Breaking — never do these to a live protocol:**

* Insert/remove/reorder fields anywhere but the end.
* Change a field's type.
* Add a *required* field (old messages will fail to decode as truncated).
* Reorder `enum`/`set` option lists (indices are the wire values — append
  new options at the end only).

For bigger changes, bump a version discriminator and use **variants** to
carry both shapes during the transition.

## 🛡 Robustness model

Two trust levels, by design:

| Direction | Policy | Why |
|---|---|---|
| **encode** (your data) | strict — throws on typos, negatives, overflow, misplaced `tail` | a bug in *your* code should explode in dev, not ship corrupted bytes |
| **decode** (their data) | defensive — bounded, validated; throws (or `tryDecode` → `null`) on anything malformed | wire input is attacker-controlled; garbage in must never mean garbage out, OOM, or a CPU spin |

Decode hard limits: varints capped at 8 bytes; array counts validated
against remaining buffer bytes **before** allocation; every declared length
checked before use; truncation detected per-field with the field name in
the error.

## ⚡ Performance

Measured on Node 22 (1M iterations, typical small messages):

| Operation | Throughput |
|---|---|
| encode, mixed message (ints + string + array) | ~1.2M ops/s |
| decode, same | ~3.4M ops/s |
| decode, enum+set message | ~7.5M ops/s |
| encode, 5 structs w/ nested arrays | ~400K ops/s |
| chained writer (2 parts) | no penalty vs merged schema |

Under the hood: schemas compile once to closures (cached by identity),
string sizing scans without allocating, UTF-8 encodes straight into the
output buffer (`TextEncoder.encodeInto`), enum/set lookups are prebuilt
maps, buffers are allocated exactly once per encode.

## 📊 Size comparison

| Data | JSON | litepack | Saved |
|---|---|---|---|
| `{ id: 123, name: 'Aviv' }` | 27 bytes | 6 bytes | **78%** |
| User with enum + set + array | 123 bytes | 26 bytes | **79%** |
| Sensor with bitfields + tail | 95 bytes | 13 bytes | **86%** |
| 5 stream-structs with nested arrays | 282 bytes | 39 bytes | **86%** |

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
* New types: `svarint`, `int64`, `json`, `const`, `map`, `uuid`,
  `timestamp`. New API: `compile`, `tryDecode`, `byteLength`,
  `assertComplete`, `reader`, `writer`, `decodeFrom`, `encodeInto`,
  `concat`, `{copy:true}` decode option, `{default:…}` field option,
  `err.truncated` for stream parsing.

## 📁 Project Structure

```
litepack.js             — single file, UMD, zero dependencies
litepack.d.ts           — TypeScript declarations (editor autocomplete)
litepack.test.js        — core test suite
litepack.chain.test.js  — streaming/composition test suite
litepack-tool.html      — interactive schema builder & tester
```

## 🥊 How does it compare?

An honest map of the landscape:

| | Approach | Strong at | Weak at (vs litepack) |
|---|---|---|---|
| **litepack** | schema in code, single file | tiny messages, zero build step, JSON-storable schemas, `bits`/`set`/`tail`/variants, deterministic bytes | ecosystem size, cross-language ports |
| **Protocol Buffers** | `.proto` files + codegen | huge ecosystem, every language, field-tag evolution (can delete fields) | heavy toolchain; requires build step or a large runtime; no bitfields |
| **MessagePack / CBOR** | schemaless | zero setup, any shape | sends key names in **every** message — 2-3× larger on small structured messages |
| **FlatBuffers** | schema + zero-copy access | reading giant buffers without deserializing | complex API, codegen required, larger output for small messages |
| **Avro** | schema as JSON | schema resolution between versions, big-data tooling | JVM-centric ecosystem, heavier runtime |

**Where litepack wins:** small, frequent, structured messages — the
per-message overhead of key names (MessagePack) or toolchain (protobuf)
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
