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

## ✨ Features

* 🗜 **Schema-defined** — describe your data once, encode/decode everywhere.
* ⚡ **Compact** — varint encoding, bitmask optionals, bitfield packing. 70-90% smaller than JSON.
* 🧩 **Rich types** — integers, floats, strings, bytes, enums, sets, bitfields, arrays, nested structs, variants.
* 🔄 **Symmetric** — `encode()` and `decode()` are the full API. What goes in comes back out.
* 🌍 **Universal** — Browser, Node.js, Workers, Bun, Deno. UMD — works with `require`, `import`, or `<script>`.
* ⚡ **Zero dependencies** — single file, ~700 lines of ES5-compatible code.
* 🔌 **Extensible** — plug in custom codecs (CBOR, MsgPack, etc.) via `litepack.codec()`.

## 📦 Installation

```
npm i litepack
```

Or just drop `litepack.js` into your project — it works standalone.

## 🚀 Quick Start

```js
var litepack = require('litepack');

// 1. Define a schema
var schema = [
    ['id',     'varint'],
    ['name',   'string'],
    ['email',  'string?'],    // optional
    ['age',    'uint8?']      // optional
];

// 2. Encode
var buf = litepack.encode(schema, {
    id: 12345,
    name: 'Aviv',
    email: 'aviv@example.com',
    age: 30
});
// buf = Uint8Array(29)  ← vs ~70 bytes in JSON

// 3. Decode
var obj = litepack.decode(schema, buf);
// { id: 12345, name: 'Aviv', email: 'aviv@example.com', age: 30 }

// Optional fields simply omit
var buf2 = litepack.encode(schema, { id: 1, name: 'Dan' });
// Uint8Array(6)

var obj2 = litepack.decode(schema, buf2);
// { id: 1, name: 'Dan' }
```

## 📋 Types

### Integers

```js
['level',    'uint8']       // 0 to 255 (1 byte)
['temp',     'int8']        // -128 to 127 (1 byte)
['port',     'uint16']      // 0 to 65535 (2 bytes)
['altitude', 'int16']       // -32768 to 32767 (2 bytes)
['color',    'uint32']      // 0 to 4294967295 (4 bytes)
['time',     'int32']       // signed 32-bit (4 bytes)
['filesize', 'uint64']      // 0 to 2^64 (8 bytes, BigInt for >2^53)
['count',    'varint']      // variable size — 1 byte for 0-127, 2 for 128-16383, etc.
```

### Floats & Bool

```js
['temperature', 'float32']  // 32-bit IEEE 754 (4 bytes)
['precise',     'float64']  // 64-bit IEEE 754 (8 bytes)
['active',      'bool']     // true/false (1 byte)
```

### Strings & Bytes

```js
['name',    'string']       // UTF-8 with varint length prefix
['payload', 'bytes']        // raw bytes with varint length prefix
['body',    'tail']         // last field — consumes remaining bytes, no prefix
['hash',    'fixed', 32]    // exactly 32 bytes, no length prefix (SHA-256, UUID, etc.)
```

### Enum & Set

```js
// Enum — single choice, stored as varint index
['status', 'enum', ['active', 'inactive', 'banned']]
// 'banned' → 0x02 (1 byte vs 8 bytes as string)

// Set — multiple choice, stored as varint bitmask (like MySQL SET)
['perms', 'set', ['read', 'write', 'execute', 'admin']]
// ['read', 'execute'] → 0x05 (1 byte — bits 0 + 2)
```

### Bits (Bitfield Packing)

```js
// Pack multiple values into minimal bytes
['flags', 'bits', [
    ['active',  1],     // 1 bit  — 0 or 1
    ['mode',    3],     // 3 bits — 0 to 7
    ['quality', 4]      // 4 bits — 0 to 15
]]
// 8 bits total = 1 byte

// encode: { flags: { active: 1, mode: 5, quality: 12 } }
// decode: { flags: { active: 1, mode: 5, quality: 12 } }
```

### Struct (Nested)

```js
['address', 'struct', [
    ['city', 'string'],
    ['zip',  'uint32']
]]

// encode: { address: { city: 'Tel Aviv', zip: 12345 } }
// decode: { address: { city: 'Tel Aviv', zip: 12345 } }

// Structs can nest:
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
// Variable length — varint count prefix
['scores', 'array', 'uint16']
// [10, 20, 30] → 03 000A 0014 001E

// Fixed length — no count prefix, saves 1 byte
['rgb', 'array', 'uint8', 3]
// [255, 128, 0] → FF 80 00

// Array of strings
['tags', 'array', 'string']
// ['hello', 'world'] → 02 05 68656C6C6F 05 776F726C64

// Array of enums
['roles', 'array', 'enum', ['admin', 'user', 'guest']]

// Array of structs
['items', 'array', 'struct', [['id', 'varint'], ['qty', 'uint16']]]
// [{ id: 1, qty: 5 }, { id: 2, qty: 10 }]

// Array of structs with fixed count
['points', 'array', 'struct', [['x', 'float32'], ['y', 'float32']], 2]
```

### Variants (Tagged Union)

```js
// Different fields based on a discriminator value
['msg_type', 'uint8', {
    '1': [['text', 'string']],
    '2': [['width', 'uint16'], ['height', 'uint16'], ['data', 'bytes']]
}]

// msg_type=1 → read text field
// msg_type=2 → read width, height, data fields
```

### Optional Fields

Any type can be optional with `?` — omitted fields cost zero bytes:

```js
['email', 'string?']
['age',   'uint8?']
['tags',  'array?', 'string']
['role',  'enum?', ['admin', 'user', 'guest']]
```

Optional fields use a varint bitmask at the start — only present fields are encoded.

## 📚 API

### `litepack.encode(schema, data)`

Encode a JavaScript object to a `Uint8Array`.

```js
var buf = litepack.encode(schema, { id: 123, name: 'Aviv' });
// → Uint8Array
```

### `litepack.decode(schema, buf)`

Decode a `Uint8Array` (or `ArrayBuffer`) back to a JavaScript object.

```js
var obj = litepack.decode(schema, buf);
// → { id: 123, name: 'Aviv' }
```

### `litepack.codec(name, { encode, decode })`

Register a custom codec for use as a field type:

```js
// Add CBOR support
var cbor = require('cbor-x');
litepack.codec('cbor', {
    encode: function(val) { return cbor.encode(val); },
    decode: function(buf) { return cbor.decode(buf); }
});

// Now use it in schemas
var schema = [['id', 'uint32'], ['payload', 'cbor']];
litepack.encode(schema, { id: 1, payload: { any: 'structure', nested: [1,2,3] } });
```

## 💡 Schema as JSON

Schemas are plain arrays — store them in JSON files, share between server and client:

```json
[
  ["id",     "varint"],
  ["name",   "string"],
  ["status", "enum",  ["active", "inactive", "banned"]],
  ["perms",  "set",   ["read", "write", "execute"]],
  ["address", "struct", [["city", "string"], ["zip", "uint32"]]],
  ["tags",   "array",  "string"]
]
```

```js
var schema = JSON.parse(fs.readFileSync('schema.json'));
litepack.encode(schema, data);
```

Schemas are compiled on first use and cached automatically — no manual compilation step.

## 📊 Size Comparison

| Data | JSON | litepack | Saved |
|---|---|---|---|
| `{ id: 123, name: 'Aviv' }` | 27 bytes | 6 bytes | **78%** |
| User with enum + set + array | 123 bytes | 26 bytes | **79%** |
| Sensor with bitfields + tail | 95 bytes | 13 bytes | **86%** |
| 3 structs in array | 80+ bytes | 11 bytes | **86%** |

## 📁 Project Structure

```
litepack.js           — single file, UMD, zero dependencies
litepack-tool.html    — interactive schema builder & tester
```

## 🤝 Contributing

Pull requests are welcome!
Please open an issue before submitting major changes.

## 📜 License

**MIT**
