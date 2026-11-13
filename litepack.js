/**
 * litepack — Lightweight binary schema encoding
 *
 * Zero dependencies. Browser, Node.js, Workers.
 * Schema-defined, varint-prefixed, optional fields via bitmask,
 * bitfield packing, tagged variants, tail bytes.
 *
 * @version 2.0.0
 *
 * 2.0 defaults: STRICT both ways. One value has exactly one encoding, and
 * decode accepts only that encoding (minimal varints, no trailing bytes, no
 * unknown optional bits / enum indices / set bits / variants, bool 0/1,
 * canonical NaN, valid UTF-8, sorted map keys). encode throws on any value
 * that would otherwise be coerced: wrong JS type, non-integer, out of range,
 * missing required field. Where safety would cost speed, speed is the default
 * and safety the option ({copy:true}); where it costs nothing, safety is the
 * default. Schemas that must evolve opt in with {extensible:true}.
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
//   > 2^53-1 (only possible in an 8-byte varint) → throw: past that a double
//   rounds, so two DIFFERENT wire values could decode to the SAME number
//   (two ids colliding) instead of failing

var MAX_VARINT_BYTES = 8;

// Truncation errors carry .truncated = true — meaning "more bytes MIGHT
// complete this message" (relevant when parsing a raw TCP stream without
// framing). Malformed errors (structurally invalid regardless of length)
// do not. See README "Streaming over raw sockets".
function truncErr(msg) {
    var e = new Error(msg);
    e.truncated = true;
    return e;
}

// Strict integer coercion for varint values: a safe non-negative integer, as a
// Number or a BigInt. Everything else throws - 1.x silently wrote 0 for a
// string or a BigInt, and floored 1.7 to 1.
function toUint53(val, what) {
    if (typeof val === 'bigint') {
        if (val < 0 || val > 9007199254740991) throw new Error('litepack: ' + what + ' value ' + val + ' out of range 0..2^53-1');
        return Number(val);
    }
    if (typeof val !== 'number') throw new TypeError('litepack: ' + what + ' expects a number, got ' + (val === null ? 'null' : typeof val));
    if (!Number.isInteger(val)) throw new Error('litepack: ' + what + ' value ' + val + ' is not an integer');
    if (val < 0) throw new Error("litepack: " + what + " cannot encode negative value " + val + " (use 'svarint' for signed)");
    if (val > 9007199254740991) throw new Error('litepack: ' + what + ' value ' + val + ' exceeds 2^53-1 (use uint64)');
    return val;
}

function writeVarint(val, buf, pos) {
    // Fast path: non-negative values below 2^31 (almost every length, id and
    // counter) — plain 32-bit ops instead of Math.floor / % (same bytes).
    if (typeof val === 'number' && val >= 0 && val < 0x80000000 && (val | 0) === val) {
        if (val < 0x80) { buf[pos] = val; return 1; }
        var p0 = pos;
        do { buf[pos++] = (val & 0x7F) | 0x80; val >>>= 7; } while (val > 0x7F);
        buf[pos++] = val;
        return pos - p0;
    }
    val = toUint53(val, 'varint');
    if (val >= 0x80000000) {
        // 2^31..2^53-1 (e.g. ms timestamps): low 28 bits as 4 groups, then the
        // rest (< 2^25) with 32-bit ops — exact integer math, same bytes.
        var lo = val % 0x10000000, hi = (val - lo) / 0x10000000, p1 = pos;
        buf[pos++] = (lo & 0x7F) | 0x80; buf[pos++] = ((lo >>> 7) & 0x7F) | 0x80;
        buf[pos++] = ((lo >>> 14) & 0x7F) | 0x80; buf[pos++] = ((lo >>> 21) & 0x7F) | 0x80;
        while (hi > 0x7F) { buf[pos++] = (hi & 0x7F) | 0x80; hi >>>= 7; }
        buf[pos++] = hi;
        return pos - p1;
    }
    var start = pos;
    while (val > 0x7F) {
        buf[pos++] = (val % 128) | 0x80;
        val = Math.floor(val / 128);
    }
    buf[pos++] = val;
    return pos - start;
}

// Readers return the VALUE and leave the number of bytes they consumed in
// _n — no { value, bytesRead } object per field. Read _n right after the
// call, before any other read can overwrite it.
var _n = 0;

// Set by the decode entry points for the duration of one decode: true when the
// schema evolves ({extensible:true}) - unknown optional bits, enum indices, set
// bits and variants are then tolerated, and decode() ignores trailing bytes.
// Saved and restored around every entry point, so a codec that decodes inside
// a decode cannot leak it.
var _ext = false;
// {bigint:true}: uint64/int64 always decode to BigInt. Default: a Number, and a
// value beyond 2^53 throws (1.x switched to BigInt for those only - one field,
// two types, depending on the value).
var _big = false;

function readVarint(buf, pos) {
    var b0 = buf[pos];
    if (b0 < 0x80) { _n = 1; return b0; }   // 1-byte fast path (undefined → slow path → truncErr)
    var val = 0, n = 0, b, mul = 1;
    do {
        if (n >= MAX_VARINT_BYTES) throw new Error('litepack: malformed varint (too long) at byte ' + (pos - n));
        b = buf[pos++];
        if (b === undefined) throw truncErr('litepack: truncated varint at byte ' + (pos - 1));
        val += (b & 0x7F) * mul;
        mul *= 128;
        n++;
    } while (b & 0x80);
    if (n === MAX_VARINT_BYTES && val > 9007199254740991) {
        throw new Error('litepack: varint at byte ' + (pos - n) + ' exceeds 2^53-1 (would lose precision)');
    }
    // A last byte of 0 adds nothing: 85 00 means the same as 05. Two byte
    // strings for one value would give one message two ids/signatures.
    if (b === 0) throw new Error('litepack: non-minimal varint at byte ' + (pos - n));
    _n = n;
    return val;
}

function varintSize(val) {
    if (typeof val === 'number' && val >= 0 && val < 0x80000000) {
        return val < 0x80 ? 1 : val < 0x4000 ? 2 : val < 0x200000 ? 3 : val < 0x10000000 ? 4 : 5;
    }
    if (typeof val === 'bigint') val = Number(val);
    if (typeof val !== 'number' || val < 0) val = 0;   // invalid: the writer throws
    val = Math.floor(val);
    var n = 1;
    while (val > 0x7F) { n++; val = Math.floor(val / 128); }
    return n;
}

// ── Signed varint (zigzag) ─────────────────────────────────
// -1→1, 1→2, -2→3, 2→4 ... small magnitudes stay small on the wire.

function zigzag(v)   { return v >= 0 ? v * 2 : -v * 2 - 1; }
// svarint range: |v| <= 2^52 - 1, so the zigzag value stays an exact double
function toInt53(v) {
    if (typeof v === 'bigint') v = Number(v);   /* range-checked below */
    if (typeof v !== 'number') throw new TypeError('litepack: svarint expects a number, got ' + (v === null ? 'null' : typeof v));
    if (!Number.isInteger(v)) throw new Error('litepack: svarint value ' + v + ' is not an integer');
    if (v > 4503599627370495 || v < -4503599627370495) throw new Error('litepack: svarint value ' + v + ' out of range ±(2^52-1)');
    return v;
}
function unzigzag(v) { return (v % 2 === 0) ? v / 2 : -(v + 1) / 2; }

// ── UTF-8 ───────────────────────────────────────────────────

var _enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
// fatal: invalid UTF-8 throws instead of becoming U+FFFD (two byte strings,
// one text). ignoreBOM: a leading U+FEFF is text, not something to drop.
var _dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : null;

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
    // Short ASCII (ids, names, keys): built directly - always valid UTF-8, and
    // faster than a TextDecoder call for a handful of bytes
    if (length <= 32) {
        var str = '', i = offset, end = offset + length;
        for (; i < end; i++) { var ch = buf[i]; if (ch >= 0x80) break; str += String.fromCharCode(ch); }
        if (i === end) return str;
    }
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
//
// Unsigned encode is STRICT, like varint: a number outside the type's range
// throws instead of being silently masked (300 as uint8 used to go out as 44 —
// for a message-type field, that is a DIFFERENT message). Non-numbers stay
// lenient (undefined → 0, true → 1), as before.
function checkInt(v, min, max, name) {
    if (typeof v !== 'number') throw new TypeError('litepack: ' + name + ' expects a number, got ' + (v === null ? 'null' : typeof v));
    if (!Number.isInteger(v) || v < min || v > max) {
        throw new Error('litepack: ' + name + ' value ' + v + ' out of range ' + min + '..' + max + ' (integers only)');
    }
}
function checkUint(v, max, name) { checkInt(v, 0, max, name); }

TYPES.uint8 = {
    size: 1,
    write: function(v, buf, pos) { checkUint(v, 0xFF, 'uint8'); buf[pos] = v & 0xFF; return 1; },
    read:  function(buf, pos) { var _v = buf[pos]; _n = 1; return _v; }
};

TYPES.int8 = {
    size: 1,
    write: function(v, buf, pos) { checkInt(v, -128, 127, 'int8'); buf[pos] = v & 0xFF; return 1; },
    read:  function(buf, pos) { var x = buf[pos]; var _v = x > 127 ? x - 256 : x; _n = 1; return _v; }
};

TYPES.uint16 = {
    size: 2,
    write: function(v, buf, pos) {
        checkUint(v, 0xFFFF, 'uint16');
        buf[pos] = (v >> 8) & 0xFF;
        buf[pos + 1] = v & 0xFF;
        return 2;
    },
    read: function(buf, pos) {
        var _v = (buf[pos] << 8) | buf[pos + 1]; _n = 2; return _v;
    }
};

TYPES.int16 = {
    size: 2,
    write: function(v, buf, pos) {
        checkInt(v, -32768, 32767, 'int16');
        buf[pos] = (v >> 8) & 0xFF;
        buf[pos + 1] = v & 0xFF;
        return 2;
    },
    read: function(buf, pos) {
        var x = (buf[pos] << 8) | buf[pos + 1];
        var _v = x > 32767 ? x - 65536 : x; _n = 2; return _v;
    }
};

TYPES.uint32 = {
    size: 4,
    write: function(v, buf, pos) {
        checkUint(v, 0xFFFFFFFF, 'uint32');
        buf[pos]     = (v >>> 24) & 0xFF;
        buf[pos + 1] = (v >>> 16) & 0xFF;
        buf[pos + 2] = (v >>> 8) & 0xFF;
        buf[pos + 3] = v & 0xFF;
        return 4;
    },
    read: function(buf, pos) {
        var _v = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0; _n = 4; return _v;
    }
};

TYPES.int32 = {
    size: 4,
    write: function(v, buf, pos) {
        checkInt(v, -2147483648, 2147483647, 'int32');
        buf[pos]     = (v >> 24) & 0xFF;
        buf[pos + 1] = (v >> 16) & 0xFF;
        buf[pos + 2] = (v >> 8) & 0xFF;
        buf[pos + 3] = v & 0xFF;
        return 4;
    },
    read: function(buf, pos) {
        var _v = (buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]; _n = 4; return _v;
    }
};

var TWO64 = typeof BigInt !== 'undefined' ? BigInt('18446744073709551616') : 0;
function check64(v, signed, name) {
    if (typeof v === 'bigint') {
        var lo = signed ? -(TWO64 >> BigInt(1)) : BigInt(0), hi = signed ? (TWO64 >> BigInt(1)) - BigInt(1) : TWO64 - BigInt(1);
        if (v < lo || v > hi) throw new Error('litepack: ' + name + ' value ' + v + ' out of range');
        return;
    }
    if (typeof v !== 'number') throw new TypeError('litepack: ' + name + ' expects a number or BigInt, got ' + (v === null ? 'null' : typeof v));
    // Numbers beyond 2^53 are already rounded: refuse rather than write a
    // neighbouring value. Pass a BigInt for those.
    if (!Number.isSafeInteger(v)) throw new Error('litepack: ' + name + ' value ' + v + ' is not a safe integer (use a BigInt above 2^53)');
    if (!signed && v < 0) throw new Error('litepack: ' + name + ' value ' + v + ' is negative');
}

TYPES.uint64 = {
    size: 8,
    write: function(v, buf, pos) {
        check64(v, false, 'uint64');
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
        _n = 8;
        if (_big) return (BigInt(hi) << BigInt(32)) | BigInt(lo);
        var v = hi * 0x100000000 + lo;
        if (v > 9007199254740991) throw new Error('litepack: uint64 at byte ' + pos + ' exceeds 2^53 (decode with {bigint:true})');
        return v;
    }
};

TYPES.int64 = {
    size: 8,
    write: function(v, buf, pos) {
        check64(v, true, 'int64');
        var hi, lo;
        if (typeof v === 'bigint') {
            var u = BigInt.asUintN(64, v);   // two's complement
            hi = Number(u >> BigInt(32)) >>> 0;
            lo = Number(u & BigInt(0xFFFFFFFF)) >>> 0;
        } else {
            lo = ((v % 0x100000000) + 0x100000000) % 0x100000000;
            hi = Math.floor(v / 0x100000000);
            if (hi < 0) hi += 0x100000000;
        }
        return writeI64(hi, lo, buf, pos);
    },
    read: function(buf, pos) {
        var hi = ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0;
        var lo = ((buf[pos + 4] << 24) | (buf[pos + 5] << 16) | (buf[pos + 6] << 8) | buf[pos + 7]) >>> 0;
        _n = 8;
        if (_big) return BigInt.asIntN(64, (BigInt(hi) << BigInt(32)) | BigInt(lo));
        var v;
        if (hi & 0x80000000) {
            // negative — compute exactly from components (no 2^64 double rounding)
            v = -((0xFFFFFFFF - hi) * 0x100000000 + (0x100000000 - lo));
        } else {
            v = hi * 0x100000000 + lo;
        }
        if (v > 9007199254740991 || v < -9007199254740991) throw new Error('litepack: int64 at byte ' + pos + ' beyond ±2^53 (decode with {bigint:true})');
        return v;
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
function checkFloat(v, name) {
    if (typeof v !== 'number') throw new TypeError('litepack: ' + name + ' expects a number, got ' + (v === null ? 'null' : typeof v));
}
TYPES.float32 = {
    size: 4,
    write: function(v, buf, pos) {
        checkFloat(v, 'float32');
        _dv.setFloat32(0, v, false);
        buf[pos] = _u8[0]; buf[pos + 1] = _u8[1]; buf[pos + 2] = _u8[2]; buf[pos + 3] = _u8[3];
        return 4;
    },
    read: function(buf, pos) {
        _u8[0] = buf[pos]; _u8[1] = buf[pos + 1]; _u8[2] = buf[pos + 2]; _u8[3] = buf[pos + 3];
        var _v = _dv.getFloat32(0, false);
        // NaN has 2^24 bit patterns; encode always writes 7FC00000
        if (_v !== _v && (buf[pos] !== 0x7F || buf[pos + 1] !== 0xC0 || buf[pos + 2] !== 0 || buf[pos + 3] !== 0)) {
            throw new Error('litepack: non-canonical NaN at byte ' + pos);
        }
        _n = 4; return _v;
    }
};

TYPES.float64 = {
    size: 8,
    write: function(v, buf, pos) {
        checkFloat(v, 'float64');
        _dv.setFloat64(0, v, false);
        for (var i = 0; i < 8; i++) buf[pos + i] = _u8[i];
        return 8;
    },
    read: function(buf, pos) {
        for (var i = 0; i < 8; i++) _u8[i] = buf[pos + i];
        var _v = _dv.getFloat64(0, false);
        if (_v !== _v) {   // one NaN encoding: 7FF8000000000000
            if (buf[pos] !== 0x7F || buf[pos + 1] !== 0xF8) throw new Error('litepack: non-canonical NaN at byte ' + pos);
            for (var j = 2; j < 8; j++) if (buf[pos + j] !== 0) throw new Error('litepack: non-canonical NaN at byte ' + pos);
        }
        _n = 8; return _v;
    }
};

// Bool
TYPES.bool = {
    size: 1,
    write: function(v, buf, pos) {
        if (v !== true && v !== false) throw new TypeError('litepack: bool expects true or false, got ' + (v === null ? 'null' : typeof v));
        buf[pos] = v ? 1 : 0; return 1;
    },
    read:  function(buf, pos) {
        var x = buf[pos];
        if (x > 1) throw new Error('litepack: bool byte ' + x + ' at ' + pos + ' (only 0 or 1)');
        _n = 1; return x === 1;
    }
};

// Varint
TYPES.varint = {
    size: null,
    write: function(v, buf, pos) { return writeVarint(v, buf, pos); },
    read:  function(buf, pos) { return readVarint(buf, pos); }
};

// Exactly-N-bytes values (fixed, uuid) — STRICT on encode, like the integers:
// the length IS the type, so a value of any other length is a bug in the
// caller, and is thrown rather than cut or zero-padded. A 64-character hex
// SHA-256 given to ['hash','fixed',32] used to be cut to its first 32 bytes
// (32 hex CHARACTERS) — a different hash, silently. A string went in as
// zeros: Uint8Array.set reads its characters as NaN.
// Missing (undefined/null) stays lenient — N zero bytes — as every other
// missing scalar encodes as its zero value (assertComplete forbids that).
function writeExact(v, len, buf, pos, name) {
    if (v instanceof ArrayBuffer) v = new Uint8Array(v);
    if (!(v instanceof Uint8Array) && !Array.isArray(v)) {
        throw new Error('litepack: ' + name + ' expects ' + len + ' bytes (Uint8Array), got ' + typeof v +
                        (typeof v === 'string' ? ' — decode hex/base64 to bytes first' : ''));
    }
    if (v.length !== len) {
        throw new Error('litepack: ' + name + ' expects exactly ' + len + ' bytes, got ' + v.length);
    }
    if (Array.isArray(v)) checkByteArray(v, name);
    buf.set(v, pos);
    return len;
}

// A plain array given as bytes: every item an integer 0..255 (buf.set would
// silently take 256 as 0 and 1.5 as 1).
function checkByteArray(a, name) {
    for (var i = 0; i < a.length; i++) {
        var x = a[i];
        if (typeof x !== 'number' || x < 0 || x > 255 || (x | 0) !== x) throw new Error('litepack: ' + name + ' byte ' + i + ' is ' + x + ' (0..255 integers only)');
    }
}
// bytes / tail input: a Uint8Array (Buffer is one), an ArrayBuffer, or a byte
// array. Other typed arrays are refused - Int16Array([300]) would go out as 44.
function asBytes(v, name) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (Array.isArray(v)) { checkByteArray(v, name); return v; }
    throw new TypeError('litepack: ' + name + ' expects a Uint8Array, got ' + (v === null ? 'null' : ArrayBuffer.isView(v) ? v.constructor.name : typeof v));
}

// UUID / 16-byte ids — exactly 16 bytes, no length prefix
TYPES.uuid = {
    size: 16,
    write: function(v, buf, pos) { return writeExact(v, 16, buf, pos, 'uuid'); },
    read: function(buf, pos) {
        if (pos + 16 > buf.length) throw truncErr('litepack: truncated uuid at byte ' + pos);
        var _v = buf.subarray(pos, pos + 16); _n = 16; return _v;
    }
};

// Signed varint (zigzag) — negative values welcome, small magnitudes stay small
TYPES.svarint = {
    size: null,
    write: function(v, buf, pos) {
        return writeVarint(zigzag(toInt53(v)), buf, pos);
    },
    read: function(buf, pos) {
        return unzigzag(readVarint(buf, pos));   // _n already set by readVarint
    }
};

// String (varint length + UTF-8)
var _hasEncodeInto = _enc && typeof _enc.encodeInto === 'function';

TYPES.string = {
    size: null,
    write: function(v, buf, pos) {
        if (typeof v !== 'string') throw new TypeError('litepack: string expects a string, got ' + (v === null ? 'null' : typeof v));
        var s = v;
        // ASCII fast path: copy char codes straight into buf. The old path's
        // buf.subarray() for encodeInto forces a small (on-heap) output
        // buffer out to a real ArrayBuffer — slower than the rest of encode.
        // On the first non-ASCII char, fall through to the full path, which
        // rewrites the field from the start (same bytes as before).
        var sl = s.length;
        if (sl < 0x80) {
            var i = 0, q = pos + 1;
            for (; i < sl; i++) {
                var c = s.charCodeAt(i);
                if (c >= 0x80) break;
                buf[q + i] = c;
            }
            if (i === sl) { buf[pos] = sl; return sl + 1; }
        }
        // a lone surrogate cannot be UTF-8: encodeInto would write U+FFFD and
        // the text would come back different
        if (typeof s.isWellFormed === 'function' ? !s.isWellFormed() : /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(s)) {
            throw new Error('litepack: string has a lone surrogate (not valid Unicode)');
        }
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
        var len = readVarint(buf, pos), lb = _n;
        if (pos + lb + len > buf.length) {
            throw truncErr('litepack: truncated string at byte ' + pos + ' (declared ' + len + ' bytes, ' + (buf.length - pos - lb) + ' remain)');
        }
        var _v;
        try { _v = utf8Decode(buf, pos + lb, len); }
        catch (e) { throw new Error('litepack: invalid UTF-8 in string at byte ' + pos); }
        _n = lb + len; return _v;
    }
};

// Bytes (varint length + raw)
TYPES.bytes = {
    size: null,
    write: function(v, buf, pos) {
        var d = asBytes(v, 'bytes');
        var lb = writeVarint(d.length, buf, pos);
        buf.set(d, pos + lb);
        return lb + d.length;
    },
    read: function(buf, pos) {
        var len = readVarint(buf, pos), lb = _n;
        var s = pos + lb;
        if (s + len > buf.length) {
            throw truncErr('litepack: truncated bytes at byte ' + pos + ' (declared ' + len + ' bytes, ' + (buf.length - s) + ' remain)');
        }
        var _v = buf.subarray(s, s + len); _n = lb + len; return _v;
    }
};

TYPES.uint8s = TYPES.bytes;

// Tail — last field, consumes remaining bytes (no length prefix)
TYPES.tail = {
    size: null,
    isTail: true,
    write: function(v, buf, pos) {
        var d = asBytes(v, 'tail');
        buf.set(d, pos);
        return d.length;
    },
    read: function(buf, pos, end) {
        var _v = buf.subarray(pos, end); _n = end - pos; return _v;
    }
};

// Ascending — a set of non-negative integers as a strictly ascending array,
// stored as gaps: count, first value, then (v[i] - v[i-1] - 1) each. Every
// byte string of minimal varints decodes to a strictly ascending array, so
// the type is canonical by construction; small gaps cost one byte each.
TYPES.ascending = {
    size: null,
    write: function(v, buf, pos) {
        if (!Array.isArray(v)) throw new TypeError('litepack: ascending expects an array, got ' + (v === null ? 'null' : typeof v));
        var start = pos, prev = -1;
        pos += writeVarint(v.length, buf, pos);
        for (var i = 0; i < v.length; i++) {
            var x = v[i];
            if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) throw new Error('litepack: ascending item ' + i + ' (' + x + ') is not a non-negative safe integer');
            if (x <= prev) throw new Error('litepack: ascending item ' + i + ' (' + x + ') is not above the previous (' + prev + ')');
            pos += writeVarint(x - prev - 1, buf, pos);
            prev = x;
        }
        return pos - start;
    },
    read: function(buf, pos) {
        var start = pos, count = readVarint(buf, pos);
        pos += _n;
        if (count > buf.length - pos) throw truncErr('litepack: ascending at byte ' + start + ' needs more bytes (count ' + count + ', ' + (buf.length - pos) + ' remain)');
        var out = new Array(count), prev = -1;
        for (var i = 0; i < count; i++) {
            var g = readVarint(buf, pos);
            pos += _n;
            prev = prev + g + 1;
            if (prev > 9007199254740991) throw new Error('litepack: ascending at byte ' + start + ' climbs past 2^53-1');
            out[i] = prev;
        }
        _n = pos - start;
        return out;
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
var POW2 = [];
for (var _p = 0; _p <= 53; _p++) POW2.push(Math.pow(2, _p));

// Compound types that REQUIRE a third schema element — catch at compile with
// a real message instead of "f.write is not a function" at encode time.
var NEEDS_DEF = { bits: 1, 'enum': 1, set: 1, fixed: 1, struct: 1, array: 1, map: 1, 'const': 1 };

var KNOWN_OPTIONS = { 'default': 1, min: 1, max: 1 };
function isOptionsObject(o) {
    var any = false;
    for (var k in o) {
        if (!o.hasOwnProperty(k)) continue;
        if (!KNOWN_OPTIONS[k]) return false;
        // a variants object keyed 'min'/'max' holds field lists, not bounds
        if ((k === 'min' || k === 'max') && typeof o[k] !== 'number' && typeof o[k] !== 'bigint') return false;
        any = true;
    }
    return any;
}

// ── Limits: {min, max} ──────────────────────────────────────
// On a length type they bound the length/count written on the wire (string:
// UTF-8 bytes); on a number type, the value. Checked on encode AND decode -
// a peer's 10 MB string is refused before it is decoded - in strict and
// extensible mode alike: limits are part of the schema (and its schemaId).
var LENGTH_TYPES = { string: 1, bytes: 1, array: 1, map: 1, ascending: 1 };
var NUMBER_TYPES = { varint: 1, svarint: 1, uint8: 1, int8: 1, uint16: 1, int16: 1, uint32: 1, int32: 1,
                     uint64: 1, int64: 1, float32: 1, float64: 1 };

function limitsOf(opts) {
    if (!opts || (!opts.hasOwnProperty('min') && !opts.hasOwnProperty('max'))) return null;
    return { min: opts.hasOwnProperty('min') ? opts.min : null, max: opts.hasOwnProperty('max') ? opts.max : null };
}

function applyLimits(f, lim) {
    var nm = f.name, lo = lim.min, hi = lim.max;
    if (lo !== null && hi !== null && lo > hi) throw new Error("litepack: field '" + nm + "' — min " + lo + ' is above max ' + hi);
    var w = f.write, r = f.read;
    if (LENGTH_TYPES[f.type]) {
        if (f.type === 'array' && f.arrayFixedCount !== null) throw new Error("litepack: field '" + nm + "' — a fixed-count array cannot take min/max");
        if ((lo !== null && (lo < 0 || lo % 1)) || (hi !== null && (hi < 0 || hi % 1))) throw new Error("litepack: field '" + nm + "' — length limits must be non-negative integers");
        var what = f.type === 'string' || f.type === 'bytes' ? 'length' : 'count';
        var check = function(n, pos) {
            if (hi !== null && n > hi) throw new Error("litepack: field '" + nm + "' — " + what + ' ' + n + ' over max ' + hi + ' at byte ' + pos);
            if (lo !== null && n < lo) throw new Error("litepack: field '" + nm + "' — " + what + ' ' + n + ' under min ' + lo + ' at byte ' + pos);
        };
        // the length/count is the varint the field starts with - read it back
        // after writing, and peek it before decoding anything else
        f.write = function(val, buf, pos) { var k = w(val, buf, pos); check(readVarint(buf, pos), pos); return k; };
        f.read = function(buf, pos) { check(readVarint(buf, pos), pos); return r(buf, pos); };
    } else if (NUMBER_TYPES[f.type]) {
        var range = function(v, where) {
            // !(v >= lo) also catches NaN: a bounded number is a number
            if ((lo !== null && !(v >= lo)) || (hi !== null && !(v <= hi))) {
                throw new Error("litepack: field '" + nm + "' — value " + v + ' outside ' + (lo === null ? '' : lo) + '..' + (hi === null ? '' : hi) + where);
            }
        };
        f.write = function(val, buf, pos) { if (typeof val === 'number' || typeof val === 'bigint') range(val, ''); return w(val, buf, pos); };
        f.read = function(buf, pos) { var v = r(buf, pos); range(v, ' at byte ' + pos); return v; };
    } else {
        throw new Error("litepack: field '" + nm + "' — min/max apply to string, bytes, array, map, ascending and number types, not '" + f.type + "'");
    }
}

// Defaults may be objects/arrays — each decode gets its OWN copy so
// mutating one decoded record can never leak into the next.
function cloneDefault(v) {
    if (Array.isArray(v)) return v.slice();
    if (v && typeof v === 'object') {
        var o = {};
        for (var k in v) if (v.hasOwnProperty(k)) o[k] = v[k];
        return o;
    }
    return v;
}

function compileFields(fieldDefs, nested, seen) {
    var fields = [];
    var optionalCount = 0;
    // Field names share one object on decode - variant branches write into the
    // parent's object - so a name may appear once across them. Two fields
    // named 'id' would encode the value twice and decode the second only.
    seen = seen || {};

    for (var i = 0; i < fieldDefs.length; i++) {
        var fd = fieldDefs[i];
        var fname = fd[0];
        var ftype = fd[1];
        var optional = false;
        var f0default, f0hasDefault = false, f0limits = null;

        if (typeof ftype !== 'string') {
            throw new Error("litepack: field '" + fname + "' — type must be a string, got " + typeof ftype);
        }
        if (typeof fname !== 'string' || fname === '' || fname === '__proto__') {
            throw new Error('litepack: invalid field name ' + JSON.stringify(fname));
        }
        if (Object.prototype.hasOwnProperty.call(seen, fname)) {
            throw new Error("litepack: field name '" + fname + "' appears twice (names must be unique in a struct and its variant branches)");
        }
        seen[fname] = true;

        // Options object at the END of the def: ['retries','varint?',{default:3}]
        // Recognized only when it's a plain object whose keys are all known
        // option names — so variant maps (whose values are schemas) never match.
        if (fd.length > 2) {
            var lastEl = fd[fd.length - 1];
            if (lastEl && typeof lastEl === 'object' && !Array.isArray(lastEl) && isOptionsObject(lastEl)) {
                fd = fd.slice(0, -1);
                if (lastEl.hasOwnProperty('default')) {
                    f0default = lastEl['default'];
                    f0hasDefault = true;
                }
                f0limits = limitsOf(lastEl);
            }
        }

        // Readability aliases — normalized here so the estimator's
        // switch-by-type-name sees the canonical name.
        if (ftype === 'timestamp') ftype = 'varint';
        else if (ftype === 'timestamp?') ftype = 'varint?';
        else if (ftype === 'uint8s') ftype = 'bytes';
        else if (ftype === 'uint8s?') ftype = 'bytes?';

        if (ftype.charAt(ftype.length - 1) === '?') {
            optional = true;
            ftype = ftype.substring(0, ftype.length - 1);
        }

        if (ftype === 'tail') {
            // 'tail' means "the rest of the buffer" — only meaningful as the
            // LAST field of a TOP-LEVEL schema. Inside a nested struct or an
            // array item there is no defined end, so it silently corrupts.
            if (nested) {
                throw new Error("litepack: field '" + fname + "' — 'tail' is not allowed inside a nested struct or array item (no defined end); use 'bytes' (length-prefixed) instead");
            }
            if (i !== fieldDefs.length - 1) {
                throw new Error("litepack: field '" + fname + "' — 'tail' must be the last field in the schema");
            }
        }

        if (NEEDS_DEF[ftype] && fd[2] === undefined) {
            throw new Error("litepack: field '" + fname + "' — type '" + ftype + "' requires a definition (third element), e.g. ['" + fname + "', '" + ftype + "', ...]");
        }
        if (ftype === 'const' && fd.length < 4) {
            throw new Error("litepack: field '" + fname + "' — const requires a base type AND a value: ['" + fname + "', 'const', 'uint8', 64]");
        }
        if (ftype === 'map' && typeof fd[3] !== 'string') {
            throw new Error("litepack: field '" + fname + "' — map requires key and value types: ['" + fname + "', 'map', 'string', 'varint']");
        }

        var f = {
            name: fname,
            type: ftype,
            optional: optional,
            hasDefault: f0hasDefault,
            defaultValue: f0default,
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
        } else if (ftype === 'map' && fd[2]) {
            // Map: ['meta','map',keyType,valType] or ['meta','map','string','struct',schema]
            f.mapDef = compileMap(fd, fname);
            f.write = createMapWriter(f.mapDef, fname);
            f.read = createMapReader(f.mapDef);
        } else if (ftype === 'const' && fd.length >= 4) {
            // Constant field: ['type','const','uint8',64]
            // encode writes the constant automatically (data value ignored);
            // decode verifies it and REJECTS the message on mismatch.
            var cBase = resolveType(fd[2], fname);
            var cVal = fd[3];
            if (!cBase.write || !cBase.read) {
                throw new Error("litepack: field '" + fname + "' — const base type '" + fd[2] + "' is not a simple type");
            }
            f.constValue = cVal;
            f.isConst = true;
            f.constBaseType = fd[2];
            f.fixedSize = cBase.size;
            f.write = (function(base, cv, nm) {
                return function(val, buf, pos) {
                    if (val !== undefined && val !== null && val !== cv) {
                        throw new Error("litepack: field '" + nm + "' is const " + JSON.stringify(cv) + ', data says ' + JSON.stringify(val));
                    }
                    return base.write(cv, buf, pos);
                };
            })(cBase, cVal, fname);
            f.read = (function(base, cv, nm) {
                return function(buf, pos) {
                    var v = base.read(buf, pos);   // _n set by base.read
                    if (v !== cv) {
                        throw new Error("litepack: field '" + nm + "' — const mismatch (expected " + JSON.stringify(cv) + ", got " + JSON.stringify(v) + ')');
                    }
                    return v;
                };
            })(cBase, cVal, fname);
        } else if (ftype === 'fixed' && fd[2]) {
            // Fixed-length bytes — no length prefix
            f.fixedLen = fd[2];
            f.fixedSize = fd[2];
            f.write = createFixedWriter(fd[2], fname);
            f.read = createFixedReader(fd[2]);
        } else if (ftype === 'struct' && fd[2]) {
            // Nested struct
            f.structDef = compileFields(fd[2], true);
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
                // each branch sees the parent's names (one decoded object), but
                // not its sibling branches' (only one branch is ever present)
                if (fd[2].hasOwnProperty(key)) f.variants[key] = compileFields(fd[2][key], nested, Object.assign({}, seen));
            }
        } else {
            // Regular field
            var typeDef = resolveType(ftype, fname);
            f.write = typeDef.write;
            f.read = typeDef.read;
            f.fixedSize = typeDef.size;
        }

        if (f0limits) applyLimits(f, f0limits);
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
    var names = Object.create(null);
    for (var i = 0; i < bitsDef.length; i++) {
        var w = bitsDef[i][1], nm = bitsDef[i][0];
        if (typeof nm !== 'string' || nm === '' || nm === '__proto__' || names[nm]) {
            throw new Error('litepack: bits subfield name ' + JSON.stringify(nm) + ' is invalid or appears twice');
        }
        names[nm] = true;
        if (typeof w !== 'number' || w < 1 || w > 32) {
            throw new Error("litepack: bits field '" + bitsDef[i][0] + "' has invalid width " + w + ' (must be 1-32)');
        }
        subFields.push({ name: bitsDef[i][0], width: w, limit: Math.pow(2, w) });
        totalBits += w;
    }
    return { subFields: subFields, totalBits: totalBits, totalBytes: Math.ceil(totalBits / 8) };
}

// Fast path (totalBits ≤ 31): everything fits one JS bitwise int — the original
// shift/mask code. General path: bit-by-bit across bytes, no 32-bit ceiling.
function checkBits(def, val) {
    if (!val || typeof val !== 'object') throw new TypeError('litepack: bits expects an object of subfields');
    for (var i = 0; i < def.subFields.length; i++) {
        var sf = def.subFields[i], v = val[sf.name];
        if (v === undefined || v === null) throw new Error("litepack: bits subfield '" + sf.name + "' is missing");
        if (typeof v === 'boolean') v = v ? 1 : 0;
        if (typeof v !== 'number' || v < 0 || v >= sf.limit || (v % 1) !== 0) {
            throw new Error("litepack: bits subfield '" + sf.name + "' value " + v + ' does not fit ' + sf.width + ' bit(s)');
        }
    }
}
function bitVal(v) { return v === true ? 1 : v === false ? 0 : v; }

function createBitsWriter(def) {
    if (def.totalBits <= 31) return function(val, buf, pos) {
        checkBits(def, val);
        var packed = 0;
        for (var i = 0; i < def.subFields.length; i++) {
            var sf = def.subFields[i];
            packed = (packed << sf.width) | bitVal(val[sf.name]);
        }
        for (var b = def.totalBytes - 1; b >= 0; b--) {
            buf[pos + b] = packed & 0xFF;
            packed = packed >>> 8;
        }
        return def.totalBytes;
    };
    // Same layout as the fast path: the field is one big-endian integer, first
    // subfield most significant, padding in the TOP bits of the first byte.
    // (1.x put the padding at the bottom of the last byte above 31 bits, so
    // adding a subfield that crossed 31 moved every existing one.)
    var padW = def.totalBytes * 8 - def.totalBits;
    return function(val, buf, pos) {
        checkBits(def, val);
        for (var b = 0; b < def.totalBytes; b++) buf[pos + b] = 0;
        var bitPos = padW;
        for (var i = 0; i < def.subFields.length; i++) {
            var sf = def.subFields[i];
            var v = bitVal(val[sf.name]) >>> 0;
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
    var pad = def.totalBytes * 8 - def.totalBits;   // unused high bits: must be 0
    if (def.totalBits <= 31) return function(buf, pos) {
        var packed = 0;
        for (var b = 0; b < def.totalBytes; b++) packed = (packed << 8) | buf[pos + b];
        if (pad && (buf[pos] >> (8 - pad))) throw new Error('litepack: bits padding not zero at byte ' + pos);
        var result = {};
        var remaining = def.totalBits;
        for (var i = 0; i < def.subFields.length; i++) {
            var sf = def.subFields[i];
            remaining -= sf.width;
            result[sf.name] = (packed >>> remaining) & ((1 << sf.width) - 1);
        }
        var _v = result; _n = def.totalBytes; return _v;
    };
    return function(buf, pos) {
        if (pad && (buf[pos] >> (8 - pad))) throw new Error('litepack: bits padding not zero at byte ' + pos);
        var result = {};
        var bitPos = pad;
        for (var i = 0; i < def.subFields.length; i++) {
            var sf = def.subFields[i];
            var v = 0;
            for (var w = 0; w < sf.width; w++) {
                v = v * 2 + ((buf[pos + (bitPos >> 3)] >> (7 - (bitPos & 7))) & 1);
                bitPos++;
            }
            result[sf.name] = v;
        }
        var _v = result; _n = def.totalBytes; return _v;
    };
}

// ── Enum compiler ───────────────────────────────────────────

function buildIndexMap(opts) {
    // O(1) value→index lookup, built once at compile — indexOf is O(n) per call
    // A plain object (a null-prototype one is a slow dictionary in V8, ~8%
    // off enum/set encode); lookups check typeof === 'number', so a value
    // like 'toString' cannot pick up Object.prototype's function.
    var m = {};
    for (var i = 0; i < opts.length; i++) {
        var o = opts[i];
        if (o === '__proto__') throw new Error("litepack: '__proto__' cannot be an enum/set option");
        // two equal options would encode as the first and decode the second
        // back to the first name - two byte strings for one value
        if (Object.prototype.hasOwnProperty.call(m, o)) throw new Error('litepack: option ' + JSON.stringify(o) + ' appears twice in an enum/set');
        m[o] = i;
    }
    return m;
}

function createEnumWriter(opts, fieldName) {
    var idxMap = buildIndexMap(opts);
    return function(val, buf, pos) {
        var idx = idxMap[val]; if (typeof idx !== 'number') idx = -1;
        if (idx === -1) {
            // Silently encoding index 0 would turn a typo into a DIFFERENT valid value.
            // Numeric passthrough is allowed for forward-compat (value from a newer peer).
            if (typeof val === 'number' && val >= 0 && Number.isInteger(val)) return writeVarint(val, buf, pos);
            throw new Error("litepack: field '" + fieldName + "' — unknown enum value " + JSON.stringify(val) + ' (options: ' + opts.join(', ') + ')');
        }
        return writeVarint(idx, buf, pos);
    };
}

function createEnumReader(opts) {
    return function(buf, pos) {
        var v = readVarint(buf, pos);   // _n set by readVarint
        if (v < opts.length) return opts[v];
        if (!_ext) throw new Error('litepack: enum index ' + v + ' at byte ' + pos + ' is not one of ' + opts.length + ' options');
        return v;
    };
}

// ── Set compiler ──────────────────────────────────────────

// Bit math via Math.pow — JS bitwise ops are 32-bit, doubles are exact to 2^53,
// so set supports up to 52 options instead of silently corrupting past 31.
var MAX_SET_OPTIONS = 52;

function createSetWriter(opts, fieldName) {
    var idxMap = buildIndexMap(opts);
    return function(val, buf, pos) {
        var mask = 0;
        if (!Array.isArray(val)) throw new TypeError("litepack: field '" + fieldName + "' — set expects an array");
        {
            for (var i = 0; i < val.length; i++) {
                var idx = idxMap[val[i]]; if (typeof idx !== 'number') idx = -1;
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
    var limit = Math.pow(2, opts.length);
    return function(buf, pos) {
        var mask = readVarint(buf, pos), lb = _n;
        if (mask >= limit && !_ext) throw new Error('litepack: set at byte ' + pos + ' has bits beyond its ' + opts.length + ' options');
        var arr = [];
        for (var i = 0; i < opts.length && mask > 0; i++) {
            if (mask % 2 === 1) arr.push(opts[i]);
            mask = Math.floor(mask / 2);
        }
        _n = lb; return arr;
    };
}

// ── Fixed compiler ──────────────────────────────────────────

// Exactly len bytes — see writeExact (strict on length).
function createFixedWriter(len, fieldName) {
    var name = "field '" + fieldName + "' (fixed " + len + ')';
    return function(val, buf, pos) { return writeExact(val, len, buf, pos, name); };
}

// ── Map: varint count + (key, value) pairs ───────────────────────────
// Keys arrive as JS object keys (always strings) — numeric key types are
// Number()ed on write and become object keys again on read.
function compileMap(fd, fname) {
    var keyType = fd[2];
    var valType = fd[3];
    var def = { keyField: makeSimpleField(keyType, fname + '.<key>'), numericKeys: keyType !== 'string' };
    if (valType === 'struct') {
        if (!Array.isArray(fd[4])) {
            throw new Error("litepack: field '" + fname + "' — map with struct values needs a schema: ['" + fname + "', 'map', '" + keyType + "', 'struct', [...]]");
        }
        var sd = compileFields(fd[4], true);
        def.valField = { type: 'struct', fixedSize: null, structDef: sd,
                         write: createStructWriter(sd), read: createStructReader(sd) };
    } else {
        def.valField = makeSimpleField(valType, fname + '.<value>');
    }
    return def;
}

function makeSimpleField(typeName, ctx) {
    if (typeName === 'array' || typeName === 'map' || typeName === 'bits' || typeName === 'tail' || typeName === 'const' || typeName === 'fixed') {
        throw new Error("litepack: '" + typeName + "' is not supported here (" + ctx + ") — wrap it in a struct");
    }
    var t = resolveType(typeName, ctx);
    return { type: typeName, fixedSize: t.size, write: t.write, read: t.read };
}

// Canonical key order: numbers ascending; strings by Unicode code point (the
// same order as their UTF-8 bytes, so any language can reproduce it). JS '<'
// compares UTF-16 units, which differs only above U+FFFF.
function cmpKeys(a, b, numeric) {
    if (numeric) return a - b;
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
        var x = a.charCodeAt(i), y = b.charCodeAt(i);
        if (x === y) continue;
        if (x >= 0xD800 && x <= 0xDFFF || y >= 0xD800 && y <= 0xDFFF) {
            var cx = a.codePointAt(i), cy = b.codePointAt(i);
            return cx - cy;
        }
        return x - y;
    }
    return a.length - b.length;
}
function createMapWriter(def, fieldName) {
    return function(val, buf, pos) {
        if (!val || typeof val !== 'object' || Array.isArray(val)) throw new TypeError("litepack: field '" + fieldName + "' — map expects a plain object");
        var keys = Object.keys(val);
        var num = def.numericKeys, sorted = true;
        for (var q = 1; q < keys.length; q++) {
            if (cmpKeys(num ? Number(keys[q - 1]) : keys[q - 1], num ? Number(keys[q]) : keys[q], num) > 0) { sorted = false; break; }
        }
        if (!sorted) {
            keys = keys.slice();
            if (num) keys.sort(function(x, y) { return Number(x) - Number(y); });
            else keys.sort(function(x, y) { return cmpKeys(x, y, false); });
        }
        if (num) for (q = 1; q < keys.length; q++) if (Number(keys[q - 1]) === Number(keys[q])) throw new Error("litepack: field '" + fieldName + "' — map keys '" + keys[q - 1] + "' and '" + keys[q] + "' are the same number");
        var start = pos;
        pos += writeVarint(keys.length, buf, pos);
        for (var i = 0; i < keys.length; i++) {
            var k = def.numericKeys ? Number(keys[i]) : keys[i];
            pos += def.keyField.write(k, buf, pos);
            pos += def.valField.write(val[keys[i]], buf, pos);
        }
        return pos - start;
    };
}

function createMapReader(def) {
    var minPair = (def.keyField.fixedSize || 1) + (def.valField.fixedSize || 1);
    return function(buf, pos) {
        var start = pos;
        var count = readVarint(buf, pos);
        pos += _n;
        if (count * minPair > buf.length - pos) {
            throw truncErr('litepack: map at byte ' + start + ' needs more bytes (count ' + count + ', ' + (buf.length - pos) + ' remain)');
        }
        var out = {}, prev, num = def.numericKeys;
        for (var i = 0; i < count; i++) {
            var at = pos;
            var k = def.keyField.read(buf, pos); pos += _n;
            // strictly increasing: sorted, and no key twice (1.x let the last win)
            if (i > 0 && cmpKeys(prev, k, num) >= 0) throw new Error('litepack: map keys out of order or repeated at byte ' + at);
            prev = k;
            var v = def.valField.read(buf, pos); pos += _n;
            // out[k] = v with k === '__proto__' would REPLACE the object's
            // prototype: the key vanishes from Object.keys and the attacker's
            // fields show up as inherited properties (1.x did this)
            if (k === '__proto__') Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
            else out[k] = v;
        }
        var _v = out; _n = pos - start; return _v;
    };
}

function createFixedReader(len) {
    return function(buf, pos) {
        if (pos + len > buf.length) {
            throw truncErr('litepack: truncated fixed(' + len + ') at byte ' + pos);
        }
        var _v = buf.subarray(pos, pos + len); _n = len; return _v;
    };
}

// ── Struct compiler ─────────────────────────────────────────

function createStructWriter(compiled) {
    return function(val, buf, pos) {
        if (!val || typeof val !== 'object') throw new TypeError('litepack: struct expects an object, got ' + (val === null ? 'null' : typeof val));
        var start = pos;
        pos = encodeFields(compiled.fields, compiled.optionalCount, val, buf, pos);
        return pos - start;
    };
}

function createStructReader(compiled) {
    return function(buf, pos) {
        var start = pos;
        var data = {};
        pos = decodeFields(compiled.fields, compiled.optionalCount, buf, pos, data, buf.length);
        var _v = data; _n = pos - start; return _v;
    };
}

// ── Array compiler ──────────────────────────────────────────

var UNSUPPORTED_ARRAY_ITEM = { array: 1, map: 1, bits: 1, tail: 1, 'const': 1 };   // 'fixed' works: ['hashes','array','fixed',32]

function compileArrayItem(fd) {
    // fd = ['name', 'array', itemType, itemDef?, fixedCount?]
    var itemType = fd[2];
    if (typeof itemType !== 'string') {
        throw new Error("litepack: field '" + fd[0] + "' — array requires an item type, e.g. ['" + fd[0] + "', 'array', 'uint16']");
    }
    if (UNSUPPORTED_ARRAY_ITEM[itemType]) {
        throw new Error("litepack: field '" + fd[0] + "' — '" + itemType + "' is not supported directly as an array item; wrap it in a struct, e.g. ['" + fd[0] + "', 'array', 'struct', [['inner', '" + itemType + "', ...]]]");
    }
    var itemField = { type: itemType, fixedSize: null };
    var nextIdx = 3;
    var fixedCount = null;

    if (itemType === 'struct' && Array.isArray(fd[nextIdx])) {
        itemField.structDef = compileFields(fd[nextIdx], true);
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
    } else if (itemType === 'fixed') {
        if (typeof fd[nextIdx] !== 'number') throw new Error("litepack: field '" + fd[0] + "' — array of fixed needs the item length: ['" + fd[0] + "', 'array', 'fixed', 32]");
        itemField.fixedLen = fd[nextIdx];
        itemField.fixedSize = fd[nextIdx];
        itemField.write = createFixedWriter(fd[nextIdx], fd[0] + '[]');
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
        if (!Array.isArray(val)) throw new TypeError('litepack: array expects an array, got ' + (val === null ? 'null' : typeof val));
        var a = val;
        if (fixedCount !== null && a.length !== fixedCount) throw new Error('litepack: array has ' + a.length + ' items, the schema fixes ' + fixedCount);
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
            count = readVarint(buf, pos);
            pos += _n;
        }
        if (count * minItemSize > buf.length - pos) {
            throw truncErr('litepack: array at byte ' + start + ' needs more bytes (count ' + count + ', ' + (buf.length - pos) + ' remain)');
        }
        var arr = new Array(count);
        for (var i = 0; i < count; i++) {
            arr[i] = itemField.read(buf, pos);
            pos += _n;
        }
        var _v = arr; _n = pos - start; return _v;
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
    if (bitmask < 0x80000000) return (bitmask & f.optionalBit) !== 0;   // optionalBit > bitmask → 0
    return Math.floor(bitmask / f.optionalBit) % 2 === 1;
}

function encodeFields(fields, optionalCount, data, buf, pos) {
    if (optionalCount > 0) pos += writeVarint(buildBitmask(fields, data), buf, pos);

    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        var val = data[f.name];
        if (val === undefined || val === null) {
            if (f.optional) continue;
            // 1.x wrote a zero value here; a missing field is a bug, and in
            // signed bytes it would sign a hole
            if (!f.isConst) throw new Error("litepack: missing required field '" + f.name + "'");
        }
        pos += f.write(val, buf, pos);
        if (f.variants) {
            var vd = f.variants[String(val)];
            if (!vd) throw new Error("litepack: field '" + f.name + "' — no variant for value " + JSON.stringify(val) + ' (known: ' + Object.keys(f.variants).join(', ') + ')');
            pos = encodeFields(vd.fields, vd.optionalCount, data, buf, pos);
        }
    }
    return pos;
}

function decodeFields(fields, optionalCount, buf, pos, data, bufEnd) {
    var bitmask = 0;
    if (optionalCount > 0) {
        var at = pos;
        bitmask = readVarint(buf, pos);
        pos += _n;
        // a bit for a field this schema does not have: a newer peer's field
        // (fine if extensible), otherwise a second encoding of the same data
        if (bitmask >= POW2[optionalCount] && !_ext) throw new Error('litepack: optional bitmask at byte ' + at + ' sets bits beyond the ' + optionalCount + ' optional fields');
    }

    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.optional && !bitmaskHas(bitmask, f)) {
            if (f.hasDefault) data[f.name] = cloneDefault(f.defaultValue);
            continue;
        }

        if (pos >= bufEnd && !f.isTail) {
            throw truncErr("litepack: truncated input — buffer ended before field '" + f.name + "'");
        }
        var value = f.isTail ? f.read(buf, pos, bufEnd) : f.read(buf, pos);
        data[f.name] = value;
        pos += _n;
        if (pos > bufEnd) {
            throw truncErr("litepack: truncated input — field '" + f.name + "' ran past end of buffer");
        }

        if (f.variants) {
            var key = String(value);
            var vd = f.variants[key];
            if (vd) {
                pos = decodeFields(vd.fields, vd.optionalCount, buf, pos, data, bufEnd);
            } else if (_ext) {
                data._unknownVariant = true;
            } else {
                throw new Error("litepack: field '" + f.name + "' — no variant for value " + JSON.stringify(value));
            }
        }
    }
    return pos;
}

// ── Size estimation ─────────────────────────────────────────

function estimateSingleField(f, val) {
    if (f.fixedSize) return f.fixedSize;
    if (f.isTail) return val instanceof ArrayBuffer ? val.byteLength : (val && val.length) || 0;

    switch (f.type) {
        case 'string':
            // Length scan only — the actual UTF-8 encoding happens ONCE, in write.
            var slen = utf8ByteLength(val == null ? '' : String(val));
            return varintSize(slen) + slen;
        case 'bytes':
            var len = val instanceof ArrayBuffer ? val.byteLength : (val && val.length) || 0;
            return varintSize(len) + len;
        case 'varint':
            return varintSize(val || 0);
        case 'ascending':
            if (!Array.isArray(val)) return 1;            // invalid: the writer throws
            var as = varintSize(val.length), ap = -1;
            for (var j = 0; j < val.length; j++) {
                var ax = val[j];
                as += (typeof ax === 'number' && ax > ap) ? varintSize(ax - ap - 1) : 1;
                ap = ax;
            }
            return as;
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
        case 'const':
            return estimateSingleField({ type: f.constBaseType, fixedSize: f.fixedSize }, f.constValue);
        case 'map':
            var mk = val ? Object.keys(val) : [];
            var ms = varintSize(mk.length);
            for (var j = 0; j < mk.length; j++) {
                ms += estimateSingleField(f.mapDef.keyField, f.mapDef.numericKeys ? Number(mk[j]) : mk[j]);
                ms += estimateSingleField(f.mapDef.valField, val[mk[j]]);
            }
            return ms;
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
    // EXACT size, and return the buffer itself — no .subarray(). In V8 a small
    // typed array (≤ 64 bytes) lives on the JS heap and is cheap (~40ns), but
    // .subarray() forces it out to a real ArrayBuffer (~650ns) — that was more
    // than the whole rest of encode. The estimate is exact for every built-in
    // type; if a custom codec ever breaks that, the overflow check still throws.
    var buf = new Uint8Array(estimateFieldSize(c.fields, c.optionalCount, data));
    var pos = encodeFields(c.fields, c.optionalCount, data, buf, 0);
    // Typed-array out-of-bounds writes are silently DROPPED — detect them,
    // never return silently corrupted bytes.
    if (pos > buf.length) throw new Error('litepack: encoded size exceeded estimate — custom codec with non-deterministic encode()?');
    return pos === buf.length ? buf : buf.subarray(0, pos);
};

/**
 * Decode data using a field list.
 *
 * @param {Array} schema - [['id', 'varint'], ['name', 'string'], ...]
 * @param {Uint8Array|ArrayBuffer} buf
 * @returns {Object}
 */
// {copy:true}: one clone of the WHOLE input up front. Every zero-copy view
// (bytes/fixed/uuid/tail) then points into OUR private copy — the caller can
// recycle or mutate their original buffer freely. One allocation, total safety.
function normalizeBuf(buf, opts) {
    if (buf instanceof ArrayBuffer) buf = new Uint8Array(buf);
    if (opts && opts.copy) buf = new Uint8Array(buf);
    return buf;
}

// One decode of a whole buffer. Strict unless the schema (compile) or the call
// says {extensible:true}: then trailing bytes - fields a newer peer appended -
// are ignored, as are unknown optional bits, enum indices, set bits, variants.
// No try/finally (it showed in small-message decode times): every entry point
// sets _ext itself, and restores it on the normal path for a codec that
// decodes inside a decode. After a throw the next entry point sets it anew.
// The optional bitmask sits at the START of a struct. A schema with no optional
// field has none, so adding its first optional field later inserts a byte in
// front of everything and an old reader misreads every field (1.x did, silently
// - its own README example did). An evolving schema must carry an optional
// field from its first version.
function checkExtensible(c) {
    if (c.optionalCount === 0) {
        throw new Error('litepack: {extensible:true} needs a schema with at least one optional field from its first version - ' +
                        'the optional bitmask is at the start, so adding the first optional field later would shift every field (reserve one, e.g. [\'ext\', \'varint?\'])');
    }
}

function decodeAll(c, buf, ext, big) {
    if (ext) checkExtensible(c);
    var prev = _ext, prevBig = _big;
    _ext = ext; _big = big;
    var data = {};
    var end = decodeFields(c.fields, c.optionalCount, buf, 0, data, buf.length);
    _ext = prev; _big = prevBig;
    if (end !== buf.length && !ext) {
        throw new Error('litepack: ' + (buf.length - end) + ' trailing byte(s) after the message (decode with {extensible:true} to allow fields from newer peers)');
    }
    return data;
}

litepack.decode = function(schema, buf, opts) {
    buf = normalizeBuf(buf, opts);
    return decodeAll(compileDef(schema), buf, !!(opts && opts.extensible), !!(opts && opts.bigint));
};

/**
 * Register a custom codec type.
 *
 * @param {string} name - Type name to use in schemas
 * @param {object} codec - { encode: fn(value) → Uint8Array, decode: fn(Uint8Array) → value }
 */
var BUILTIN = null;   // filled once the built-ins (json included) exist
litepack.codec = function(name, codec) {
    if (!codec || typeof codec.encode !== 'function' || typeof codec.decode !== 'function') {
        throw new Error("litepack.codec: requires { encode, decode }");
    }
    // 1.x let codec('string', ...) replace the string type for every schema
    if (BUILTIN && BUILTIN[name]) throw new Error("litepack.codec: '" + name + "' is a built-in type and cannot be replaced");
    TYPES[name] = _codecs[name] = {
        size: null,
        write: function(val, buf, pos) {
            var encoded = codec.encode(val);
            var lb = writeVarint(encoded.length, buf, pos);
            buf.set(encoded, pos + lb);
            return lb + encoded.length;
        },
        read: function(buf, pos) {
            var len = readVarint(buf, pos), lb = _n;
            var s = pos + lb;
            // without this the codec would see a silently shortened slice
            if (s + len > buf.length) throw truncErr("litepack: truncated '" + name + "' at byte " + pos + ' (declared ' + len + ' bytes, ' + (buf.length - s) + ' remain)');
            var _v = codec.decode(buf.subarray(s, s + len)); _n = lb + len; return _v;
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
litepack.compile = function(schema, copts) {
    var c = compileFields(schema);
    var ext = !!(copts && copts.extensible), big = !!(copts && copts.bigint);
    if (ext) checkExtensible(c);
    return {
        encode: function(data) {
            data = data || {};
            var buf = new Uint8Array(estimateFieldSize(c.fields, c.optionalCount, data));   // exact — see litepack.encode
            var pos = encodeFields(c.fields, c.optionalCount, data, buf, 0);
            if (pos > buf.length) throw new Error('litepack: encoded size exceeded estimate — custom codec with non-deterministic encode()?');
            return pos === buf.length ? buf : buf.subarray(0, pos);
        },
        decode: function(buf, opts) {
            buf = normalizeBuf(buf, opts);
            return decodeAll(c, buf, ext || !!(opts && opts.extensible), big || !!(opts && opts.bigint));
        },
        tryDecode: function(buf, opts) {
            try { return this.decode(buf, opts); } catch (e) { return null; }
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
litepack.tryDecode = function(schema, buf, opts) {
    try {
        return litepack.decode(schema, buf, opts);
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

// =========================================================================
// Streaming / composition — for frames that carry MORE than one message.
//
// decode() answers "what is in this buffer"; these answer "what is NEXT in
// this buffer". Message framing (header proto + body proto, or N packed
// messages) stops being manual Uint8Array surgery:
//
//   // read: header decides which body proto to use
//   var r = litepack.reader(frame);
//   var head = r.read(headerProto);
//   var body = r.read(head.sub === SUB.LIST ? listBodyProto : scalarBodyProto);
//
//   // write: pack several messages into one frame, single allocation
//   var frame = litepack.writer()
//       .write(headerProto, { type: 64, sub: 5 })
//       .write(scalarBodyProto, { subjectPeerId: id, value: 1 })
//       .bytes();
//
// Wire format note: chaining protoA then protoB produces byte-identical
// output to one merged proto with the same fields IN THE SAME ORDER — as
// long as each part keeps its own optionals. (Schemas are plain arrays, so
// headerProto.concat(bodyProto) is also a valid merged schema.)
// =========================================================================

/**
 * Decode one message starting at `offset`. Returns { value, bytesRead } —
 * the primitive that decode() hides. Trailing bytes are left alone.
 */
litepack.decodeFrom = function(schema, buf, offset, opts) {
    buf = normalizeBuf(buf, opts);
    offset = offset || 0;
    var c = compileDef(schema);
    var data = {}, prev = _ext, prevBig = _big;
    if (opts && opts.extensible) checkExtensible(c);
    _ext = !!(opts && opts.extensible); _big = !!(opts && opts.bigint);
    var end = decodeFields(c.fields, c.optionalCount, buf, offset, data, buf.length);
    _ext = prev; _big = prevBig;
    return { value: data, bytesRead: end - offset };
};

/**
 * Encode `data` directly into an existing buffer at `offset`.
 * Returns bytes written. Throws if it will not fit — typed-array
 * out-of-bounds writes are silently dropped, never rely on them.
 */
litepack.encodeInto = function(schema, data, buf, offset) {
    offset = offset || 0;
    data = data || {};
    var c = compileDef(schema);
    var need = estimateFieldSize(c.fields, c.optionalCount, data);
    if (offset + need > buf.length) {
        throw new Error('litepack: encodeInto needs ' + need + ' bytes at offset ' + offset + ', buffer has ' + (buf.length - offset));
    }
    return encodeFields(c.fields, c.optionalCount, data, buf, offset) - offset;
};

/** Concatenate Uint8Arrays into one (single allocation). */
litepack.concat = function(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], pos); pos += list[i].length; }
    return out;
};

/**
 * Sequential reading cursor over a buffer holding chained messages.
 *   r.read(proto)     — decode next message, advance (throws on malformed)
 *   r.tryRead(proto)  — same, but null on malformed (cursor NOT advanced)
 *   r.peek(proto)     — decode without advancing
 *   r.remaining()     — bytes left
 *   r.eof()           — no bytes left
 *   r.skip(n)         — advance n bytes (e.g. past a foreign message)
 *   r.offset          — current position
 */
litepack.reader = function(buf, opts) {
    buf = normalizeBuf(buf, opts);
    var ropts = opts && (opts.extensible || opts.bigint) ? { extensible: !!opts.extensible, bigint: !!opts.bigint } : undefined;
    var r = {
        offset: 0,
        read: function(schema) {
            var res = litepack.decodeFrom(schema, buf, r.offset, ropts);
            r.offset += res.bytesRead;
            return res.value;
        },
        tryRead: function(schema) {
            try { return r.read(schema); } catch (e) { return null; }
        },
        peek: function(schema) {
            return litepack.decodeFrom(schema, buf, r.offset, ropts).value;
        },
        skip: function(n) { r.offset += n; return r; },
        remaining: function() { return buf.length - r.offset; },
        eof: function() { return r.offset >= buf.length; }
    };
    return r;
};

/**
 * Chained-message builder. Collects (schema, data) pairs, then emits one
 * exactly-sized buffer — no intermediate arrays, no manual concat.
 *   litepack.writer().write(a, d1).write(b, d2).bytes()
 */
litepack.writer = function() {
    var parts = [];     // [compiled, data, size]
    var total = 0;
    var w = {
        write: function(schema, data) {
            var c = compileDef(schema);
            data = data || {};
            var size = estimateFieldSize(c.fields, c.optionalCount, data);
            parts.push([c, data, size]);
            total += size;
            return w;
        },
        raw: function(bytes) {           // splice in pre-encoded/foreign bytes
            parts.push([null, bytes, bytes.length]);
            total += bytes.length;
            return w;
        },
        byteLength: function() { return total; },
        bytes: function() {
            var buf = new Uint8Array(total);
            var pos = 0;
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i];
                if (p[0] === null) { buf.set(p[1], pos); pos += p[2]; }
                else pos = encodeFields(p[0].fields, p[0].optionalCount, p[1], buf, pos);
            }
            if (pos > buf.length) throw new Error('litepack: writer overflow — custom codec with non-deterministic encode()?');
            return pos === total ? buf : buf.subarray(0, pos);
        }
    };
    return w;
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
/**
 * Throws exactly when encode would throw: a missing required field (nested
 * ones too - array items, variant branches, map values), a wrong type, a value
 * out of range. encode already checks all of this in 2.0; this stays for code
 * that wants the check without the bytes.
 */
litepack.assertComplete = function(schema, data) {
    litepack.encode(schema, data);
    return true;
};

// Built-in 'json' type — escape hatch for free-form data inside a binary
// schema (varint length + UTF-8 JSON). Not compact, but always available:
//   ['meta', 'json']  ← any serializable structure
litepack.codec('json', {
    encode: function(v) { return utf8Encode(JSON.stringify(v === undefined ? null : v)); },
    decode: function(b) { return JSON.parse(utf8Decode(b, 0, b.length)); }
});

BUILTIN = {};
for (var _t in TYPES) if (TYPES.hasOwnProperty(_t)) BUILTIN[_t] = true;
BUILTIN.timestamp = true;

// ── Schema identity ─────────────────────────────────────────
//
// schemaId(schema) names a schema by its MEANING on the wire: two schemas get
// the same id exactly when they read and write the same bytes into the same
// object shape. Peers send it in a handshake (or store it beside saved data)
// to find out that they disagree BEFORE decoding garbage - litepack messages
// carry no type information, so a mismatch is otherwise silent.
//
// Hashed: the canonical JSON below, prefixed 'litepack-schema-v1\n', with
// MurmurHash3-32 (schemaId); schemaBytes hands the same bytes to any hash.
// In:  field and subfield names, types (aliases resolved), '?' markers,
//      enum/set option names and order, bits widths, fixed lengths, array
//      fixed counts, const base+value, map key/value types, variant keys.
// Out: {default: ...} options and decode options - they do not touch bytes.
// Custom codecs enter by NAME only (their code cannot be hashed): bump the
// codec's name when you change its encoding.

var ALIAS = { timestamp: 'varint', uint8s: 'bytes' };
function normType(t) {
    var opt = t.charAt(t.length - 1) === '?', b = opt ? t.slice(0, -1) : t;
    return (ALIAS[b] || b) + (opt ? '?' : '');
}
function normFields(fds) {
    var out = [];
    for (var i = 0; i < fds.length; i++) out.push(normField(fds[i]));
    return out;
}
function normField(fd) {
    var lim = null;
    if (fd.length > 2) {
        var last = fd[fd.length - 1];
        if (last && typeof last === 'object' && !Array.isArray(last) && isOptionsObject(last)) { fd = fd.slice(0, -1); lim = limitsOf(last); }
    }
    var out = normField2(fd);
    // limits change which bytes are accepted, so they are part of the id
    if (lim) {
        var l = {};
        if (lim.min !== null) l.min = lim.min;
        if (lim.max !== null) l.max = lim.max;
        out.push({ limits: l });
    }
    return out;
}
function normField2(fd) {
    var type = normType(fd[1]), base = type.replace(/\?$/, ''), out = [fd[0], type];
    if (base === 'struct') out.push(normFields(fd[2]));
    else if (base === 'bits') out.push(fd[2].map(function (b) { return [b[0], b[1]]; }));
    else if (base === 'enum' || base === 'set') out.push(fd[2].slice());
    else if (base === 'fixed') out.push(fd[2]);
    else if (base === 'const') out.push(normType(fd[2]), fd[3]);
    else if (base === 'map') {
        out.push(normType(fd[2]), normType(fd[3]));
        if (fd[3] === 'struct') out.push(normFields(fd[4]));
    } else if (base === 'array') {
        var item = normType(fd[2]), k = 3;
        out.push(item);
        if (item === 'struct') out.push(normFields(fd[k++]));
        else if (item === 'enum' || item === 'set') out.push(fd[k++].slice());
        else if (item === 'bits') out.push(fd[k++].map(function (b) { return [b[0], b[1]]; }));
        else if (item === 'fixed') out.push(fd[k++]);
        if (typeof fd[k] === 'number') out.push({ count: fd[k] });
    } else if (fd[2] && typeof fd[2] === 'object' && !Array.isArray(fd[2])) {
        // variants: an object's key order is insertion order - sort it away
        var keys = Object.keys(fd[2]).sort(function (a, b) { return cmpKeys(a, b, false); }), v = [];
        for (var i = 0; i < keys.length; i++) v.push([keys[i], normFields(fd[2][keys[i]])]);
        out.push({ variants: v });
    }
    return out;
}
function canonJSON(x) {
    if (typeof x === 'bigint') return '{"$bigint":"' + x.toString() + '"}';
    if (Array.isArray(x)) return '[' + x.map(canonJSON).join(',') + ']';
    if (x && typeof x === 'object') {
        var keys = Object.keys(x).sort(function (a, b) { return cmpKeys(a, b, false); });
        return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonJSON(x[k]); }).join(',') + '}';
    }
    if (typeof x === 'number' && !isFinite(x)) return '{"$float":"' + x + '"}';
    return JSON.stringify(x);   // -0 prints as 0: const -0 and 0 encode alike only for ints
}

// MurmurHash3, 32-bit (x86_32, seed 0) - small, fast in JS (Math.imul), and
// in every language. Not cryptographic: the id catches an accidental
// mismatch. Hash schemaBytes() yourself for anything else.
function murmur3(b) {
    var n = b.length, h = 0, i = 0, k;
    for (; i + 4 <= n; i += 4) {
        k = b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24;
        k = Math.imul(k, 0xCC9E2D51); k = k << 15 | k >>> 17; k = Math.imul(k, 0x1B873593);
        h ^= k; h = h << 13 | h >>> 19; h = (Math.imul(h, 5) + 0xE6546B64) | 0;
    }
    k = 0;
    switch (n & 3) {
        case 3: k ^= b[i + 2] << 16;
        case 2: k ^= b[i + 1] << 8;
        case 1: k ^= b[i];
            k = Math.imul(k, 0xCC9E2D51); k = k << 15 | k >>> 17; k = Math.imul(k, 0x1B873593); h ^= k;
    }
    h ^= n;
    h ^= h >>> 16; h = Math.imul(h, 0x85EBCA6B);
    h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35);
    h ^= h >>> 16;
    return h >>> 0;
}

var _ids = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
function idEntry(schema) {
    var e = _ids && _ids.get(schema);
    if (!e) {
        compileDef(schema);            // an invalid schema throws here, not hashes
        var input = utf8Encode('litepack-schema-v1\n' + canonJSON(normFields(schema)));
        e = { input: input, id: murmur3(input) };
        if (_ids) _ids.set(schema, e);
    }
    return e;
}

/**
 * The schema's id: MurmurHash3-32 of schemaBytes(schema), a number in
 * [0, 2^32). Same id = same bytes into the same object shape. Cached.
 */
litepack.schemaId = function(schema) { return idEntry(schema).id; };

/**
 * The bytes schemaId hashes - 'litepack-schema-v1\n' + the canonical JSON of
 * the schema, UTF-8. Hash them with any function you like.
 */
litepack.schemaBytes = function(schema) { return idEntry(schema).input.slice(); };

litepack.version = '2.0.0';

return litepack;

});
