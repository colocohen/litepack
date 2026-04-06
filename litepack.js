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

function writeVarint(val, buf, pos) {
    val = val >>> 0 || 0;
    var start = pos;
    while (val > 0x7F) {
        buf[pos++] = (val & 0x7F) | 0x80;
        val = val >>> 7;
    }
    buf[pos++] = val & 0x7F;
    return pos - start;
}

function readVarint(buf, pos) {
    var val = 0, shift = 0, b;
    do {
        b = buf[pos++];
        val |= (b & 0x7F) << shift;
        shift += 7;
    } while (b & 0x80);
    return { value: val >>> 0, bytesRead: shift / 7 };
}

function varintSize(val) {
    val = val >>> 0 || 0;
    var n = 1;
    while (val > 0x7F) { n++; val = val >>> 7; }
    return n;
}

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

// String (varint length + UTF-8)
TYPES.string = {
    size: null,
    write: function(v, buf, pos) {
        var enc = utf8Encode(v || '');
        var lb = writeVarint(enc.length, buf, pos);
        buf.set(enc, pos + lb);
        return lb + enc.length;
    },
    read: function(buf, pos) {
        var l = readVarint(buf, pos);
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

function compileFields(fieldDefs) {
    var fields = [];
    var optionalCount = 0;

    for (var i = 0; i < fieldDefs.length; i++) {
        var fd = fieldDefs[i];
        var fname = fd[0];
        var ftype = fd[1];
        var optional = false;

        if (ftype.charAt(ftype.length - 1) === '?') {
            optional = true;
            ftype = ftype.substring(0, ftype.length - 1);
        }

        var f = {
            name: fname,
            type: ftype,
            optional: optional,
            optionalIndex: optional ? optionalCount : -1,
            isTail: ftype === 'tail',
            bitsDef: null,
            variants: null,
            fixedSize: null,
            write: null,
            read: null
        };

        if (optional) optionalCount++;

        if (ftype === 'bits' && fd[2]) {
            // Bitfield
            f.bitsDef = compileBits(fd[2]);
            f.fixedSize = f.bitsDef.totalBytes;
            f.write = createBitsWriter(f.bitsDef);
            f.read = createBitsReader(f.bitsDef);
        } else if (ftype === 'enum' && fd[2]) {
            // Enum — single choice from list, stored as varint index
            f.enumOpts = fd[2];
            f.write = createEnumWriter(fd[2]);
            f.read = createEnumReader(fd[2]);
        } else if (ftype === 'set' && fd[2]) {
            // Set — multiple choice from list, stored as varint bitmask
            f.setOpts = fd[2];
            f.write = createSetWriter(fd[2]);
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
            var typeDef = resolveType(ftype);
            f.write = typeDef.write;
            f.read = typeDef.read;
            f.fixedSize = typeDef.size;
            f.variants = {};
            for (var key in fd[2]) {
                if (fd[2].hasOwnProperty(key)) f.variants[key] = compileFields(fd[2][key]);
            }
        } else {
            // Regular field
            var typeDef = resolveType(ftype);
            f.write = typeDef.write;
            f.read = typeDef.read;
            f.fixedSize = typeDef.size;
        }

        fields.push(f);
    }

    return { fields: fields, optionalCount: optionalCount };
}

function resolveType(name) {
    var t = TYPES[name];
    if (t) return t;

    // Check custom codecs
    var codec = _codecs[name];
    if (codec) return codec;

    throw new Error("litepack: unknown type '" + name + "'");
}

// ── Bitfield compiler ───────────────────────────────────────

function compileBits(bitsDef) {
    var subFields = [];
    var totalBits = 0;
    for (var i = 0; i < bitsDef.length; i++) {
        subFields.push({ name: bitsDef[i][0], width: bitsDef[i][1] });
        totalBits += bitsDef[i][1];
    }
    return { subFields: subFields, totalBits: totalBits, totalBytes: Math.ceil(totalBits / 8) };
}

function createBitsWriter(def) {
    return function(val, buf, pos) {
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
}

function createBitsReader(def) {
    return function(buf, pos) {
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
}

// ── Enum compiler ───────────────────────────────────────────

function createEnumWriter(opts) {
    return function(val, buf, pos) {
        var idx = opts.indexOf(val);
        return writeVarint(idx === -1 ? 0 : idx, buf, pos);
    };
}

function createEnumReader(opts) {
    return function(buf, pos) {
        var r = readVarint(buf, pos);
        return { value: r.value < opts.length ? opts[r.value] : r.value, bytesRead: r.bytesRead };
    };
}

// ── Set compiler ──────────────────────────────────────────

function createSetWriter(opts) {
    return function(val, buf, pos) {
        var mask = 0;
        if (val) {
            for (var i = 0; i < val.length; i++) {
                var idx = opts.indexOf(val[i]);
                if (idx !== -1) mask |= (1 << idx);
            }
        }
        return writeVarint(mask, buf, pos);
    };
}

function createSetReader(opts) {
    return function(buf, pos) {
        var r = readVarint(buf, pos);
        var arr = [];
        for (var i = 0; i < opts.length; i++) {
            if (r.value & (1 << i)) arr.push(opts[i]);
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
        itemField.write = createEnumWriter(fd[nextIdx]);
        itemField.read = createEnumReader(fd[nextIdx]);
        nextIdx++;
    } else if (itemType === 'set' && Array.isArray(fd[nextIdx])) {
        itemField.setOpts = fd[nextIdx];
        itemField.write = createSetWriter(fd[nextIdx]);
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
        var t = resolveType(itemType);
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
    var bitmask = 0;
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.optional) {
            var val = data[f.name];
            if (val !== undefined && val !== null) bitmask |= (1 << f.optionalIndex);
        }
    }
    return bitmask;
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
        if (f.optional && !(bitmask & (1 << f.optionalIndex))) continue;

        var result = f.isTail ? f.read(buf, pos, bufEnd) : f.read(buf, pos);
        data[f.name] = result.value;
        pos += result.bytesRead;

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
            var enc = utf8Encode(val || '');
            return varintSize(enc.length) + enc.length;
        case 'bytes':
            var len = (val && val.length) || 0;
            return varintSize(len) + len;
        case 'varint':
            return varintSize(val || 0);
        case 'enum':
            var idx = f.enumOpts ? f.enumOpts.indexOf(val) : 0;
            return varintSize(idx === -1 ? 0 : idx);
        case 'set':
            var mask = 0;
            if (val && f.setOpts) {
                for (var j = 0; j < val.length; j++) {
                    var fi = f.setOpts.indexOf(val[j]);
                    if (fi !== -1) mask |= (1 << fi);
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
 */
function compileDef(schema) {
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

litepack.version = '1.0.0';

return litepack;

});
