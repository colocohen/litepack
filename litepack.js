/**
 * litepack — Lightweight binary schema encoding
 *
 * Zero dependencies. Browser, Node.js, Workers.
 * Schema-defined, varint-prefixed, optional fields via bitmask,
 * bitfield packing, tagged variants, tail bytes.
 *
 * @version 1.0.0
 * @license MIT
 */
(function(root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
    else if (typeof define === 'function' && define.amd) define(factory);
    else root.litepack = factory();
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function() {
'use strict';

// ── Varint (unsigned LEB128) ────────────────────────────────
//
// Encode side is STRICT (your own data — fail fast on bugs):
//   negative        → throw (use 'svarint' for signed values)
//   > 2^53-1        → throw (would silently lose precision)
//   non-number      → 0 (lenient for missing/undefined)
// Decode side is DEFENSIVE (wire data — bounded, never trusts input):
//   max 8 bytes (56 bits > 2^53 cap) → throw on longer sequences

var MAX_VARINT_BYTES = 8;

function writeVarint(val, buf, pos) {
    if (typeof val !== 'number') val = 0;
    else if (val < 0) throw new Error("litepack: varint cannot encode negative value " + val + " (use 'svarint' for signed)");
    else if (val > 9007199254740991) throw new Error('litepack: varint value ' + val + ' exceeds 2^53-1 (use uint64)');
    val = Math.floor(val);
    var start = pos;
    while (val > 0x7F) {
        buf[pos++] = (val % 128) | 0x80;
        val = Math.floor(val / 128);
    }
    buf[pos++] = val;
    return pos - start;
}

function readVarint(buf, pos) {
    var val = 0, n = 0, b, mul = 1;
    do {
        if (n >= MAX_VARINT_BYTES) throw new Error('litepack: malformed varint (too long) at byte ' + (pos - n));
        b = buf[pos++];
        if (b === undefined) throw new Error('litepack: truncated varint at byte ' + (pos - 1));
        val += (b & 0x7F) * mul;
        mul *= 128;
        n++;
    } while (b & 0x80);
    return { value: val, bytesRead: n };
}

function varintSize(val) {
    if (typeof val !== 'number' || val < 0) val = 0;
    val = Math.floor(val);
    var n = 1;
    while (val > 0x7F) { n++; val = Math.floor(val / 128); }
    return n;
}

// ── Signed varint (zigzag) ─────────────────────────────────
// -1→1, 1→2, -2→3, 2→4 ... small magnitudes stay small on the wire.

function zigzag(v)   { return v >= 0 ? v * 2 : -v * 2 - 1; }
function unzigzag(v) { return (v % 2 === 0) ? v / 2 : -(v + 1) / 2; }

// ── UTF-8 ───────────────────────────────────────────────────

var _enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
var _dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function utf8Encode(str) {
    if (_enc) return _enc.encode(str);
    var arr = [];
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) {
            arr.push(c);
        } else if (c < 0x800) {
            arr.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
        } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
            var next = str.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
                c = ((c - 0xD800) << 10) + (next - 0xDC00) + 0x10000;
                i++;
                arr.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
            }
        } else {
            arr.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
        }
    }
    return new Uint8Array(arr);
}

// Byte length WITHOUT encoding — used by the estimate pass so strings are
// only actually encoded once (in write). No allocation, just a scan.
function utf8ByteLength(str) {
    var bytes = 0;
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) bytes += 1;
        else if (c < 0x800) bytes += 2;
        else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length &&
                 str.charCodeAt(i + 1) >= 0xDC00 && str.charCodeAt(i + 1) <= 0xDFFF) {
            bytes += 4; i++;   // surrogate pair
        }
        else bytes += 3;
    }
    return bytes;
}

function utf8Decode(buf, offset, length) {
    if (_dec) return _dec.decode(buf.subarray(offset, offset + length));
    var str = '', end = offset + length, i = offset;
    while (i < end) {
        var c = buf[i++];
        if (c < 0x80) {
            str += String.fromCharCode(c);
        } else if (c < 0xE0) {
            str += String.fromCharCode(((c & 0x1F) << 6) | (buf[i++] & 0x3F));
        } else if (c < 0xF0) {
            str += String.fromCharCode(((c & 0x0F) << 12) | ((buf[i++] & 0x3F) << 6) | (buf[i++] & 0x3F));
        } else {
            var cp = ((c & 0x07) << 18) | ((buf[i++] & 0x3F) << 12) | ((buf[i++] & 0x3F) << 6) | (buf[i++] & 0x3F);
            cp -= 0x10000;
            str += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        }
    }
    return str;
}

// ── Float via shared DataView ───────────────────────────────

var _ab = new ArrayBuffer(8);
var _dv = new DataView(_ab);
var _u8 = new Uint8Array(_ab);

// ── Custom codecs (e.g. CBOR, MsgPack) ─────────────────────

var _codecs = {};

// ── Field types ─────────────────────────────────────────────

var TYPES = {};

// Fixed-size integers
TYPES.uint8 = {
    size: 1,
    write: function(v, buf, pos) { buf[pos] = v & 0xFF; return 1; },
    read:  function(buf, pos) { return { value: buf[pos], bytesRead: 1 }; }
};

TYPES.int8 = {
    size: 1,
    write: function(v, buf, pos) { buf[pos] = v & 0xFF; return 1; },
    read:  function(buf, pos) { var x = buf[pos]; return { value: x > 127 ? x - 256 : x, bytesRead: 1 }; }
};

TYPES.uint16 = {
    size: 2,
    write: function(v, buf, pos) {
        buf[pos] = (v >> 8) & 0xFF;
        buf[pos + 1] = v & 0xFF;
        return 2;
    },
    read: function(buf, pos) {
        return { value: (buf[pos] << 8) | buf[pos + 1], bytesRead: 2 };
    }
};

TYPES.int16 = {
    size: 2,
    write: function(v, buf, pos) {
        buf[pos] = (v >> 8) & 0xFF;
        buf[pos + 1] = v & 0xFF;
        return 2;
    },
    read: function(buf, pos) {
        var x = (buf[pos] << 8) | buf[pos + 1];
        return { value: x > 32767 ? x - 65536 : x, bytesRead: 2 };
    }
};

TYPES.uint32 = {
    size: 4,
    write: function(v, buf, pos) {
        buf[pos]     = (v >>> 24) & 0xFF;
        buf[pos + 1] = (v >>> 16) & 0xFF;
        buf[pos + 2] = (v >>> 8) & 0xFF;
        buf[pos + 3] = v & 0xFF;
        return 4;
    },
    read: function(buf, pos) {
        return { value: ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0, bytesRead: 4 };
    }
};

TYPES.int32 = {
    size: 4,
    write: function(v, buf, pos) {
        buf[pos]     = (v >> 24) & 0xFF;
        buf[pos + 1] = (v >> 16) & 0xFF;
        buf[pos + 2] = (v >> 8) & 0xFF;
        buf[pos + 3] = v & 0xFF;
        return 4;
    },
    read: function(buf, pos) {
        return { value: (buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3], bytesRead: 4 };
    }
};

TYPES.uint64 = {
    size: 8,
    write: function(v, buf, pos) {
        var hi, lo;
        if (typeof v === 'bigint') {
            hi = Number(v >> BigInt(32)) >>> 0;
            lo = Number(v & BigInt(0xFFFFFFFF)) >>> 0;
        } else {
            hi = (v / 0x100000000) >>> 0;
            lo = v >>> 0;
        }
        buf[pos]     = (hi >>> 24) & 0xFF;
        buf[pos + 1] = (hi >>> 16) & 0xFF;
        buf[pos + 2] = (hi >>> 8) & 0xFF;
        buf[pos + 3] = hi & 0xFF;
        buf[pos + 4] = (lo >>> 24) & 0xFF;
        buf[pos + 5] = (lo >>> 16) & 0xFF;
        buf[pos + 6] = (lo >>> 8) & 0xFF;
        buf[pos + 7] = lo & 0xFF;
        return 8;
    },
    read: function(buf, pos) {
        var hi = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0;
        var lo = ((buf[pos + 4] << 24) | (buf[pos + 5] << 16) | (buf[pos + 6] << 8) | buf[pos + 7]) >>> 0;
        var v = hi * 0x100000000 + lo;
        if (v > 9007199254740991 && typeof BigInt !== 'undefined') {
            v = (BigInt(hi) << BigInt(32)) | BigInt(lo);
        }
        return { value: v, bytesRead: 8 };
    }
};

TYPES.int64 = {
    size: 8,
    write: function(v, buf, pos) {
        var hi, lo;
        if (typeof v === 'bigint') {
            var u = BigInt.asUintN(64, v);   // two's complement
            hi = Number(u >> BigInt(32)) >>> 0;
            lo = Number(u & BigInt(0xFFFFFFFF)) >>> 0;
        } else {
            v = v || 0;
            lo = ((v % 0x100000000) + 0x100000000) % 0x100000000;
            hi = Math.floor(v / 0x100000000);
            if (hi < 0) hi += 0x100000000;
        }
        return writeI64(hi, lo, buf, pos);
    },
    read: function(buf, pos) {
        var hi = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0;
        var lo = ((buf[pos + 4] << 24) | (buf[pos + 5] << 16) | (buf[pos + 6] << 8) | buf[pos + 7]) >>> 0;
        var v;
        if (hi & 0x80000000) {
            // negative — compute exactly from components (no 2^64 double rounding)
            v = -((0xFFFFFFFF - hi) * 0x100000000 + (0x100000000 - lo));
            if (v < -9007199254740991 && typeof BigInt !== 'undefined') {
                v = BigInt.asIntN(64, (BigInt(hi) << BigInt(32)) | BigInt(lo));
            }
        } else {
            v = hi * 0x100000000 + lo;
            if (v > 9007199254740991 && typeof BigInt !== 'undefined') {
                v = (BigInt(hi) << BigInt(32)) | BigInt(lo);
            }
        }
        return { value: v, bytesRead: 8 };
    }
};

function writeI64(hi, lo, buf, pos) {
    buf[pos]     = (hi >>> 24) & 0xFF;
    buf[pos + 1] = (hi >>> 16) & 0xFF;
    buf[pos + 2] = (hi >>> 8) & 0xFF;
    buf[pos + 3] = hi & 0xFF;
    buf[pos + 4] = (lo >>> 24) & 0xFF;
    buf[pos + 5] = (lo >>> 16) & 0xFF;
    buf[pos + 6] = (lo >>> 8) & 0xFF;
    buf[pos + 7] = lo & 0xFF;
    return 8;
}

// Floats
TYPES.float32 = {
    size: 4,
    write: function(v, buf, pos) {
        _dv.setFloat32(0, v, false);
        buf[pos] = _u8[0]; buf[pos + 1] = _u8[1]; buf[pos + 2] = _u8[2]; buf[pos + 3] = _u8[3];
        return 4;
    },
    read: function(buf, pos) {
        _u8[0] = buf[pos]; _u8[1] = buf[pos + 1]; _u8[2] = buf[pos + 2]; _u8[3] = buf[pos + 3];
        return { value: _dv.getFloat32(0, false), bytesRead: 4 };
    }
};

TYPES.float64 = {
    size: 8,
    write: function(v, buf, pos) {
        _dv.setFloat64(0, v, false);
        for (var i = 0; i < 8; i++) buf[pos + i] = _u8[i];
        return 8;
    },
    read: function(buf, pos) {
        for (var i = 0; i < 8; i++) _u8[i] = buf[pos + i];
        return { value: _dv.getFloat64(0, false), bytesRead: 8 };
    }
};

// Bool
TYPES.bool = {
    size: 1,
    write: function(v, buf, pos) { buf[pos] = v ? 1 : 0; return 1; },
    read:  function(buf, pos) { return { value: buf[pos] !== 0, bytesRead: 1 }; }
};

// Varint
TYPES.varint = {
    size: null,
    write: function(v, buf, pos) { return writeVarint(v, buf, pos); },
    read:  function(buf, pos) { return readVarint(buf, pos); }
};

// Signed varint (zigzag) — negative values welcome, small magnitudes stay small
TYPES.svarint = {
    size: null,
    write: function(v, buf, pos) {
        if (typeof v !== 'number') v = 0;
        return writeVarint(zigzag(Math.round(v)), buf, pos);
    },
    read: function(buf, pos) {
        var r = readVarint(buf, pos);
        return { value: unzigzag(r.value), bytesRead: r.bytesRead };
    }
};

// String (varint length + UTF-8)
var _hasEncodeInto = _enc && typeof _enc.encodeInto === 'function';

TYPES.string = {
    size: null,
    write: function(v, buf, pos) {
        var s = v == null ? '' : String(v);
        var len = utf8ByteLength(s);
        var lb = writeVarint(len, buf, pos);
        if (_hasEncodeInto) {
            // Encode straight into the output buffer — zero intermediate allocation
            _enc.encodeInto(s, buf.subarray(pos + lb, pos + lb + len));
        } else {
            buf.set(utf8Encode(s), pos + lb);
        }
        return lb + len;
    },
    read: function(buf, pos) {
        var l = readVarint(buf, pos);
        if (pos + l.bytesRead + l.value > buf.length) {
            throw new Error('litepack: truncated string at byte ' + pos + ' (declared ' + l.value + ' bytes, ' + (buf.length - pos - l.bytesRead) + ' remain)');
        }
        return { value: utf8Decode(buf, pos + l.bytesRead, l.value), bytesRead: l.bytesRead + l.value };
    }
};

// Bytes (varint length + raw)
TYPES.bytes = {
    size: null,
    write: function(v, buf, pos) {
        var d = v || new Uint8Array(0);
        var lb = writeVarint(d.length, buf, pos);
        buf.set(d, pos + lb);
        return lb + d.length;
    },
    read: function(buf, pos) {
        var l = readVarint(buf, pos);
        var s = pos + l.bytesRead;
        if (s + l.value > buf.length) {
            throw new Error('litepack: truncated bytes at byte ' + pos + ' (declared ' + l.value + ' bytes, ' + (buf.length - s) + ' remain)');
        }
        return { value: buf.subarray(s, s + l.value), bytesRead: l.bytesRead + l.value };
    }
};

TYPES.uint8s = TYPES.bytes;

// Tail — last field, consumes remaining bytes (no length prefix)
TYPES.tail = {
    size: null,
    isTail: true,
    write: function(v, buf, pos) {
        var d = v || new Uint8Array(0);
        buf.set(d, pos);
        return d.length;
    },
    read: function(buf, pos, end) {
        return { value: buf.subarray(pos, end), bytesRead: end - pos };
    }
};

// Compiled per field — bits, enum, set, fixed, struct, array
TYPES.bits = { size: null };
TYPES.enum = { size: null };
TYPES.set = { size: null };
TYPES.fixed = { size: null };
TYPES.struct = { size: null };
TYPES.array = { size: null };

// ── Schema compiler ─────────────────────────────────────────

// Optional bitmask + set both live in a varint. Doubles are exact to 2^53,
// so 52 flag bits are safe. Past that we throw at COMPILE time — loudly,
// instead of corrupting data at runtime like a 32-bit shift would.
var MAX_OPTIONAL_FIELDS = 52;

// Compound types that REQUIRE a third schema element — catch at compile with
// a real message instead of "f.write is not a function" at encode time.
var NEEDS_DEF = { bits: 1, 'enum': 1, set: 1, fixed: 1, struct: 1, array: 1 };

function compileFields(fieldDefs) {
    var fields = [];
    var optionalCount = 0;

    for (var i = 0; i < fieldDefs.length; i++) {
        var fd = fieldDefs[i];
        var fname = fd[0];
        var ftype = fd[1];
        var optional = false;

        if (typeof ftype !== 'string') {
            throw new Error("litepack: field '" + fname + "' — type must be a string, got " + typeof ftype);
        }

        if (ftype.charAt(ftype.length - 1) === '?') {
            optional = true;
            ftype = ftype.substring(0, ftype.length - 1);
        }

        if (NEEDS_DEF[ftype] && fd[2] === undefined) {
            throw new Error("litepack: field '" + fname + "' — type '" + ftype + "' requires a definition (third element), e.g. ['" + fname + "', '" + ftype + "', ...]");
        }

        var f = {
            name: fname,
            type: ftype,
            optional: optional,
            optionalIndex: optional ? optionalCount : -1,
            optionalBit: optional ? Math.pow(2, optionalCount) : 0,
            isTail: ftype === 'tail',
            bitsDef: null,
            variants: null,
            fixedSize: null,
            write: null,
            read: null
        };

        if (optional) {
            optionalCount++;
            if (optionalCount > MAX_OPTIONAL_FIELDS) {
                throw new Error('litepack: more than ' + MAX_OPTIONAL_FIELDS + ' optional fields in one struct (bitmask limit) — split into nested structs');
            }
        }

        if (ftype === 'bits' && fd[2]) {
            // Bitfield
            f.bitsDef = compileBits(fd[2]);
            f.fixedSize = f.bitsDef.totalBytes;
            f.write = createBitsWriter(f.bitsDef);
            f.read = createBitsReader(f.bitsDef);
        } else if (ftype === 'enum' && fd[2]) {
            // Enum — single choice from list, stored as varint index
            f.enumOpts = fd[2];
            f.write = createEnumWriter(fd[2], fname);
            f.read = createEnumReader(fd[2]);
        } else if (ftype === 'set' && fd[2]) {
            // Set — multiple choice from list, stored as varint bitmask
            if (fd[2].length > MAX_SET_OPTIONS) {
                throw new Error("litepack: field '" + fname + "' — set supports up to " + MAX_SET_OPTIONS + ' options, got ' + fd[2].length);
            }
            f.setOpts = fd[2];
            f.write = createSetWriter(fd[2], fname);
            f.read = createSetReader(fd[2]);
        } else if (ftype === 'fixed' && fd[2]) {
            // Fixed-length bytes — no length prefix
            f.fixedLen = fd[2];
            f.fixedSize = fd[2];
            f.write = createFixedWriter(fd[2]);
            f.read = createFixedReader(fd[2]);
        } else if (ftype === 'struct' && fd[2]) {
            // Nested struct
            f.structDef = compileFields(fd[2]);
            f.write = createStructWriter(f.structDef);
            f.read = createStructReader(f.structDef);
        } else if (ftype === 'array' && fd[2]) {
            // Array — compileArrayItem figures out item type and optional fixed count
            var arr = compileArrayItem(fd);
            f.arrayItem = arr.itemField;
            f.arrayFixedCount = arr.fixedCount;
            f.write = createArrayWriter(arr.itemField, arr.fixedCount);
            f.read = createArrayReader(arr.itemField, arr.fixedCount);
        } else if (fd[2] && typeof fd[2] === 'object' && !Array.isArray(fd[2])) {
            // Variants (tagged union)
            var typeDef = resolveType(ftype, fname);
            f.write = typeDef.write;
            f.read = typeDef.read;
            f.fixedSize = typeDef.size;
            f.variants = {};
            for (var key in fd[2]) {
                if (fd[2].hasOwnProperty(key)) f.variants[key] = compileFields(fd[2][key]);
            }
        } else {
            // Regular field
            var typeDef = resolveType(ftype, fname);
            f.write = typeDef.write;
            f.read = typeDef.read;
            f.fixedSize = typeDef.size;
        }

        fields.push(f);
    }

    return { fields: fields, optionalCount: optionalCount };
}

function resolveType(name, fieldName) {
    var t = TYPES[name];
    if (t) return t;

    // Check custom codecs
    var codec = _codecs[name];
    if (codec) return codec;

    throw new Error("litepack: unknown type '" + name + "'" + (fieldName ? " for field '" + fieldName + "'" : '') + ' — known types: ' + Object.keys(TYPES).join(', '));
}

// ── Bitfield compiler ───────────────────────────────────────

function compileBits(bitsDef) {
    var subFields = [];
    var totalBits = 0;
    for (var i = 0; i < bitsDef.length; i++) {
        var w = bitsDef[i][1];
        if (typeof w !== 'number' || w < 1 || w > 32) {
            throw new Error("litepack: bits field '" + bitsDef[i][0] + "' has invalid width " + w + ' (must be 1-32)');
        }
        subFields.push({ name: bitsDef[i][0], width: w });
        totalBits += w;
    }
    return { subFields: subFields, totalBits: totalBits, totalBytes: Math.ceil(totalBits / 8) };
}

// Fast path (totalBits ≤ 31): everything fits one JS bitwise int — the original
// shift/mask code. General path: bit-by-bit across bytes, no 32-bit ceiling.
function createBitsWriter(def) {
    if (def.totalBits <= 31) return function(val, buf, pos) {
        var packed = 0;
        for (var i = 0; i < def.subFields.length; i++) {
            var sf = def.subFields[i];
            var v = (val && val[sf.name]) || 0;
            packed = (packed << sf.width) | (v & ((1 << sf.width) - 1));
        }
        for (var b = def.totalBytes - 1; b >= 0; b--) {
            buf[pos + b] = packed & 0xFF;
            packed = packed >>> 8;
        }
        return def.totalBytes;
    };
    return function(val, buf, pos) {
        for (var b = 0; b < def.totalBytes; b++) buf[pos + b] = 0;
        var bitPos = 0;
        for (var i = 0; i < def.subFields.length; i++) {
            var sf = def.subFields[i];
            var v = ((val && val[sf.name]) || 0) >>> 0;
            for (var w = sf.width - 1; w >= 0; w--) {
                if ((w < 31 ? (v >>> w) : Math.floor(v / 0x80000000)) & 1) {
                    buf[pos + (bitPos >> 3)] |= 0x80 >> (bitPos & 7);
                }
                bitPos++;
            }
        }
        return def.totalBytes;
    };
}

function createBitsReader(def) {
    if (def.totalBits <= 31) return function(buf, pos) {
        var packed = 0;
        for (var b = 0; b < def.totalBytes; b++) packed = (packed << 8) | buf[pos + b];
        var result = {};
        var remaining = def.totalBits;
        for (var i = 0; i < def.subFields.length; i++) {
            var sf = def.subFields[i];
            remaining -= sf.width;
            result[sf.name] = (packed >>> remaining) & ((1 << sf.width) - 1);
        }
        return { value: result, bytesRead: def.totalBytes };
    };
    return function(buf, pos) {
        var result = {};
        var bitPos = 0;
        for (var i = 0; i < def.subFields.length; i++) {
            var sf = def.subFields[i];
            var v = 0;
            for (var w = 0; w < sf.width; w++) {
                v = v * 2 + ((buf[pos + (bitPos >> 3)] >> (7 - (bitPos & 7))) & 1);
                bitPos++;
            }
            result[sf.name] = v;
        }
        return { value: result, bytesRead: def.totalBytes };
    };
}

// ── Enum compiler ───────────────────────────────────────────

function createEnumWriter(opts, fieldName) {
    return function(val, buf, pos) {
        var idx = opts.indexOf(val);
        if (idx === -1) {
            // Silently encoding index 0 would turn a typo into a DIFFERENT valid value.
            // Numeric passthrough is allowed for forward-compat (value from a newer peer).
            if (typeof val === 'number' && val >= 0) return writeVarint(val, buf, pos);
            if (val === undefined || val === null) return writeVarint(0, buf, pos);
            throw new Error("litepack: field '" + fieldName + "' — unknown enum value " + JSON.stringify(val) + ' (options: ' + opts.join(', ') + ')');
        }
        return writeVarint(idx, buf, pos);
    };
}

function createEnumReader(opts) {
    return function(buf, pos) {
        var r = readVarint(buf, pos);
        return { value: r.value < opts.length ? opts[r.value] : r.value, bytesRead: r.bytesRead };
    };
}

// ── Set compiler ──────────────────────────────────────────

// Bit math via Math.pow — JS bitwise ops are 32-bit, doubles are exact to 2^53,
// so set supports up to 52 options instead of silently corrupting past 31.
var MAX_SET_OPTIONS = 52;

function createSetWriter(opts, fieldName) {
    return function(val, buf, pos) {
        var mask = 0;
        if (val) {
            for (var i = 0; i < val.length; i++) {
                var idx = opts.indexOf(val[i]);
                if (idx === -1) {
                    throw new Error("litepack: field '" + fieldName + "' — unknown set value " + JSON.stringify(val[i]) + ' (options: ' + opts.join(', ') + ')');
                }
                var bit = Math.pow(2, idx);
                if (Math.floor(mask / bit) % 2 === 0) mask += bit;   // dedup-safe
            }
        }
        return writeVarint(mask, buf, pos);
    };
}

function createSetReader(opts) {
    return function(buf, pos) {
        var r = readVarint(buf, pos);
        var arr = [];
        var mask = r.value;
        for (var i = 0; i < opts.length && mask > 0; i++) {
            if (mask % 2 === 1) arr.push(opts[i]);
            mask = Math.floor(mask / 2);
        }
        return { value: arr, bytesRead: r.bytesRead };
    };
}

// ── Fixed compiler ──────────────────────────────────────────

function createFixedWriter(len) {
    return function(val, buf, pos) {
        var d = val || new Uint8Array(len);
        buf.set(d.length > len ? d.subarray(0, len) : d, pos);
        if (d.length < len) for (var i = d.length; i < len; i++) buf[pos + i] = 0;
        return len;
    };
}

function createFixedReader(len) {
    return function(buf, pos) {
        if (pos + len > buf.length) {
            throw new Error('litepack: truncated fixed(' + len + ') at byte ' + pos);
        }
        return { value: buf.subarray(pos, pos + len), bytesRead: len };
    };
}

// ── Struct compiler ─────────────────────────────────────────

function createStructWriter(compiled) {
    return function(val, buf, pos) {
        var start = pos;
        pos = encodeFields(compiled.fields, compiled.optionalCount, val || {}, buf, pos);
        return pos - start;
    };
}

function createStructReader(compiled) {
    return function(buf, pos) {
        var start = pos;
        var data = {};
        pos = decodeFields(compiled.fields, compiled.optionalCount, buf, pos, data, buf.length);
        return { value: data, bytesRead: pos - start };
    };
}

// ── Array compiler ──────────────────────────────────────────

function compileArrayItem(fd) {
    // fd = ['name', 'array', itemType, itemDef?, fixedCount?]
    var itemType = fd[2];
    if (typeof itemType !== 'string') {
        throw new Error("litepack: field '" + fd[0] + "' — array requires an item type, e.g. ['" + fd[0] + "', 'array', 'uint16']");
    }
    var itemField = { type: itemType, fixedSize: null };
    var nextIdx = 3;
    var fixedCount = null;

    if (itemType === 'struct' && Array.isArray(fd[nextIdx])) {
        itemField.structDef = compileFields(fd[nextIdx]);
        itemField.write = createStructWriter(itemField.structDef);
        itemField.read = createStructReader(itemField.structDef);
        nextIdx++;
    } else if (itemType === 'enum' && Array.isArray(fd[nextIdx])) {
        itemField.enumOpts = fd[nextIdx];
        itemField.write = createEnumWriter(fd[nextIdx], fd[0]);
        itemField.read = createEnumReader(fd[nextIdx]);
        nextIdx++;
    } else if (itemType === 'set' && Array.isArray(fd[nextIdx])) {
        itemField.setOpts = fd[nextIdx];
        itemField.write = createSetWriter(fd[nextIdx], fd[0]);
        itemField.read = createSetReader(fd[nextIdx]);
        nextIdx++;
    } else if (itemType === 'bits' && Array.isArray(fd[nextIdx])) {
        var def = compileBits(fd[nextIdx]);
        itemField.bitsDef = def;
        itemField.fixedSize = def.totalBytes;
        itemField.write = createBitsWriter(def);
        itemField.read = createBitsReader(def);
        nextIdx++;
    } else if (itemType === 'fixed' && typeof fd[nextIdx] === 'number') {
        itemField.fixedLen = fd[nextIdx];
        itemField.fixedSize = fd[nextIdx];
        itemField.write = createFixedWriter(fd[nextIdx]);
        itemField.read = createFixedReader(fd[nextIdx]);
        nextIdx++;
    } else {
        var t = resolveType(itemType, fd[0]);
        itemField.write = t.write;
        itemField.read = t.read;
        itemField.fixedSize = t.size;
    }

    if (typeof fd[nextIdx] === 'number') fixedCount = fd[nextIdx];

    return { itemField: itemField, fixedCount: fixedCount };
}

function createArrayWriter(itemField, fixedCount) {
    return function(val, buf, pos) {
        var a = val || [];
        var start = pos;
        if (fixedCount === null) pos += writeVarint(a.length, buf, pos);
        var count = fixedCount !== null ? fixedCount : a.length;
        for (var i = 0; i < count; i++) {
            pos += itemField.write(a[i], buf, pos);
        }
        return pos - start;
    };
}

function createArrayReader(itemField, fixedCount) {
    // Every item costs ≥ minItemSize bytes on the wire, so count can never
    // legitimately exceed remaining/minItemSize. Without this check, a peer
    // sending 8 bytes (varint count ≈ 2^40) makes `new Array(count)` OOM the
    // process — a trivially cheap DoS against anything decoding wire data.
    var minItemSize = itemField.fixedSize || 1;
    return function(buf, pos) {
        var start = pos;
        var count;
        if (fixedCount !== null) {
            count = fixedCount;
        } else {
            var cr = readVarint(buf, pos);
            count = cr.value;
            pos += cr.bytesRead;
        }
        if (count * minItemSize > buf.length - pos) {
            throw new Error('litepack: malformed array at byte ' + start + ' (count ' + count + ' cannot fit in ' + (buf.length - pos) + ' remaining bytes)');
        }
        var arr = new Array(count);
        for (var i = 0; i < count; i++) {
            var r = itemField.read(buf, pos);
            arr[i] = r.value;
            pos += r.bytesRead;
        }
        return { value: arr, bytesRead: pos - start };
    };
}

// ── Encode / Decode engine ──────────────────────────────────

function buildBitmask(fields, data) {
    // += with precomputed power-of-2 bits — exact in doubles up to 2^52,
    // unlike (1 << i) which silently wraps past 31 optional fields.
    var bitmask = 0;
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.optional) {
            var val = data[f.name];
            if (val !== undefined && val !== null) bitmask += f.optionalBit;
        }
    }
    return bitmask;
}

function bitmaskHas(bitmask, f) {
    return Math.floor(bitmask / f.optionalBit) % 2 === 1;
}

function encodeFields(fields, optionalCount, data, buf, pos) {
    if (optionalCount > 0) pos += writeVarint(buildBitmask(fields, data), buf, pos);

    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.optional) {
            var val = data[f.name];
            if (val === undefined || val === null) continue;
        }
        pos += f.write(data[f.name], buf, pos);
        if (f.variants) {
            var key = String(data[f.name]);
            var vd = f.variants[key];
            if (vd) pos = encodeFields(vd.fields, vd.optionalCount, data, buf, pos);
        }
    }
    return pos;
}

function decodeFields(fields, optionalCount, buf, pos, data, bufEnd) {
    var bitmask = 0;
    if (optionalCount > 0) {
        var br = readVarint(buf, pos);
        bitmask = br.value;
        pos += br.bytesRead;
    }

    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.optional && !bitmaskHas(bitmask, f)) continue;

        if (pos >= bufEnd && !f.isTail) {
            throw new Error("litepack: truncated input — buffer ended before field '" + f.name + "'");
        }
        var result = f.isTail ? f.read(buf, pos, bufEnd) : f.read(buf, pos);
        data[f.name] = result.value;
        pos += result.bytesRead;
        if (pos > bufEnd) {
            throw new Error("litepack: truncated input — field '" + f.name + "' ran past end of buffer");
        }

        if (f.variants) {
            var key = String(result.value);
            var vd = f.variants[key];
            if (vd) {
                pos = decodeFields(vd.fields, vd.optionalCount, buf, pos, data, bufEnd);
            } else {
                data._unknownVariant = true;
            }
        }
    }
    return pos;
}

// ── Size estimation ─────────────────────────────────────────

function estimateSingleField(f, val) {
    if (f.fixedSize) return f.fixedSize;
    if (f.isTail) return (val && val.length) || 0;

    switch (f.type) {
        case 'string':
            // Length scan only — the actual UTF-8 encoding happens ONCE, in write.
            var slen = utf8ByteLength(val == null ? '' : String(val));
            return varintSize(slen) + slen;
        case 'bytes':
            var len = (val && val.length) || 0;
            return varintSize(len) + len;
        case 'varint':
            return varintSize(val || 0);
        case 'svarint':
            return varintSize(zigzag(Math.round(typeof val === 'number' ? val : 0)));
        case 'enum':
            var idx = f.enumOpts ? f.enumOpts.indexOf(val) : 0;
            if (idx === -1 && typeof val === 'number' && val >= 0) return varintSize(val);  // numeric passthrough
            return varintSize(idx === -1 ? 0 : idx);
        case 'set':
            var mask = 0;
            if (val && f.setOpts) {
                for (var j = 0; j < val.length; j++) {
                    var fi = f.setOpts.indexOf(val[j]);
                    if (fi !== -1) {
                        var bit = Math.pow(2, fi);
                        if (Math.floor(mask / bit) % 2 === 0) mask += bit;
                    }
                }
            }
            return varintSize(mask);
        case 'fixed':
            return f.fixedLen;
        case 'struct':
            return estimateFieldSize(f.structDef.fields, f.structDef.optionalCount, val || {});
        case 'array':
            var a = val || [];
            var count = f.arrayFixedCount !== null ? f.arrayFixedCount : a.length;
            var s = f.arrayFixedCount !== null ? 0 : varintSize(count);
            for (var j = 0; j < count; j++) {
                s += estimateSingleField(f.arrayItem, a[j]);
            }
            return s;
        default:
            // Custom codec — must have estimateSize or we encode to measure
            var codec = _codecs[f.type];
            if (codec && codec.estimateSize) return codec.estimateSize(val);
            if (codec) {
                var tmp = new Uint8Array(65536);
                return codec.write(val, tmp, 0);
            }
            return 0;
    }
}

function estimateFieldSize(fields, optionalCount, data) {
    var size = 0;
    if (optionalCount > 0) size += varintSize(buildBitmask(fields, data));

    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.optional) {
            var val = data[f.name];
            if (val === undefined || val === null) continue;
        }
        size += estimateSingleField(f, data[f.name]);
        if (f.variants) {
            var key = String(data[f.name]);
            var vd = f.variants[key];
            if (vd) size += estimateFieldSize(vd.fields, vd.optionalCount, data);
        }
    }
    return size;
}

// ── Public API ──────────────────────────────────────────────

var litepack = {};

/**
 * Compile a field list. Cached after first call.
 * WeakMap keeps the cache OFF the user's schema array (no _lp property
 * injection — frozen schemas work, Object.keys stays clean). Falls back to
 * the _lp property on very old engines without WeakMap.
 */
var _compiled = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

function compileDef(schema) {
    if (_compiled) {
        var c = _compiled.get(schema);
        if (!c) { c = compileFields(schema); _compiled.set(schema, c); }
        return c;
    }
    if (schema._lp) return schema._lp;
    schema._lp = compileFields(schema);
    return schema._lp;
}

/**
 * Encode data using a field list.
 *
 * @param {Array} schema - [['id', 'varint'], ['name', 'string'], ...]
 * @param {Object} data
 * @returns {Uint8Array}
 */
litepack.encode = function(schema, data) {
    var c = compileDef(schema);
    data = data || {};
    var buf = new Uint8Array(estimateFieldSize(c.fields, c.optionalCount, data) + 16);
    var pos = encodeFields(c.fields, c.optionalCount, data, buf, 0);
    // Typed-array out-of-bounds writes are silently DROPPED — detect them,
    // never return silently corrupted bytes.
    if (pos > buf.length) throw new Error('litepack: encoded size exceeded estimate — custom codec with non-deterministic encode()?');
    return buf.subarray(0, pos);
};

/**
 * Decode data using a field list.
 *
 * @param {Array} schema - [['id', 'varint'], ['name', 'string'], ...]
 * @param {Uint8Array|ArrayBuffer} buf
 * @returns {Object}
 */
litepack.decode = function(schema, buf) {
    if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
    var c = compileDef(schema);
    var data = {};
    decodeFields(c.fields, c.optionalCount, buf, 0, data, buf.length);
    return data;
};

/**
 * Register a custom codec type.
 *
 * @param {string} name - Type name to use in schemas
 * @param {object} codec - { encode: fn(value) → Uint8Array, decode: fn(Uint8Array) → value }
 */
litepack.codec = function(name, codec) {
    if (!codec || typeof codec.encode !== 'function' || typeof codec.decode !== 'function') {
        throw new Error("litepack.codec: requires { encode, decode }");
    }
    TYPES[name] = _codecs[name] = {
        size: null,
        write: function(val, buf, pos) {
            var encoded = codec.encode(val);
            var lb = writeVarint(encoded.length, buf, pos);
            buf.set(encoded, pos + lb);
            return lb + encoded.length;
        },
        read: function(buf, pos) {
            var l = readVarint(buf, pos);
            var s = pos + l.bytesRead;
            return { value: codec.decode(buf.subarray(s, s + l.value)), bytesRead: l.bytesRead + l.value };
        },
        estimateSize: function(val) {
            var encoded = codec.encode(val);
            return varintSize(encoded.length) + encoded.length;
        }
    };
};

/**
 * Pre-compile a schema into a bound handle. Skips per-call cache lookups
 * and reads nicer at call sites:
 *
 *   var Cert = litepack.compile(certProto);
 *   var buf  = Cert.encode(data);
 *   var obj  = Cert.decode(buf);
 */
litepack.compile = function(schema) {
    var c = compileFields(schema);
    return {
        encode: function(data) {
            data = data || {};
            var buf = new Uint8Array(estimateFieldSize(c.fields, c.optionalCount, data) + 16);
            var pos = encodeFields(c.fields, c.optionalCount, data, buf, 0);
            if (pos > buf.length) throw new Error('litepack: encoded size exceeded estimate — custom codec with non-deterministic encode()?');
            return buf.subarray(0, pos);
        },
        decode: function(buf) {
            if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
            var data = {};
            decodeFields(c.fields, c.optionalCount, buf, 0, data, buf.length);
            return data;
        },
        byteLength: function(data) {
            return estimateFieldSize(c.fields, c.optionalCount, data || {});
        }
    };
};

/**
 * Like decode, but returns null instead of throwing on malformed input.
 * The right call for wire data from untrusted peers:
 *
 *   var msg = litepack.tryDecode(proto, e.data.data);
 *   if (!msg) return;   // malformed / truncated / hostile — drop it
 */
litepack.tryDecode = function(schema, buf) {
    try {
        return litepack.decode(schema, buf);
    } catch (e) {
        return null;
    }
};

/**
 * Exact encoded size of `data` under `schema`, without encoding.
 * Useful for pre-allocating transport frames or enforcing size budgets.
 */
litepack.byteLength = function(schema, data) {
    var c = compileDef(schema);
    return estimateFieldSize(c.fields, c.optionalCount, data || {});
};

/**
 * Throw if any NON-OPTIONAL field is missing (undefined/null), recursing
 * into structs. encode() itself stays lenient (missing string → ''), but
 * for canonical/signed bytes that leniency is a hazard: a record missing
 * its publicKey would silently sign as an EMPTY key. Call this first on
 * any signing path:
 *
 *   litepack.assertComplete(certSignProto, cert);   // throws with field path
 *   var bytes = litepack.encode(certSignProto, cert);
 */
litepack.assertComplete = function(schema, data, _path) {
    var c = compileDef(schema);
    var path = _path || '';
    data = data || {};
    for (var i = 0; i < c.fields.length; i++) {
        var f = c.fields[i];
        var val = data[f.name];
        if (f.optional) continue;
        if (val === undefined || val === null) {
            throw new Error("litepack: missing required field '" + path + f.name + "'");
        }
        if (f.type === 'struct' && f.structDef) {
            litepack.assertComplete._check(f.structDef, val, path + f.name + '.');
        }
    }
    return true;
};
litepack.assertComplete._check = function(compiled, data, path) {
    for (var i = 0; i < compiled.fields.length; i++) {
        var f = compiled.fields[i];
        var val = (data || {})[f.name];
        if (f.optional) continue;
        if (val === undefined || val === null) {
            throw new Error("litepack: missing required field '" + path + f.name + "'");
        }
        if (f.type === 'struct' && f.structDef) {
            litepack.assertComplete._check(f.structDef, val, path + f.name + '.');
        }
    }
};

// Built-in 'json' type — escape hatch for free-form data inside a binary
// schema (varint length + UTF-8 JSON). Not compact, but always available:
//   ['meta', 'json']  ← any serializable structure
litepack.codec('json', {
    encode: function(v) { return utf8Encode(JSON.stringify(v === undefined ? null : v)); },
    decode: function(b) { return JSON.parse(utf8Decode(b, 0, b.length)); }
});

litepack.version = '1.1.0';

return litepack;

});
