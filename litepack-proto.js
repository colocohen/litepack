/*
 * litepack-proto — move from Protocol Buffers to litepack.
 *
 *   var lpProto = require('./litepack-proto.js');
 *   var root = protobuf.loadSync('people.proto');          // protobufjs, or pbjs -t json
 *   var m = lpProto.fromProto(root, 'tutorial.AddressBook');
 *
 *   m.schema                 // a litepack schema: {fields, types}
 *   m.toLitepack(obj)        // a protobufjs object (Type.toObject) → litepack data
 *   m.fromLitepack(data)     // litepack data → an object Type.fromObject accepts
 *   m.encode(litepack, obj)  // shortcut: protobufjs object → litepack bytes
 *   m.decode(litepack, buf)  // shortcut: litepack bytes → protobufjs object
 *   m.notes                  // every choice that is not one-to-one, in words
 *
 * The input is protobufjs's JSON descriptor (root.toJSON(), or the file
 * `pbjs -t json` writes); a protobufjs Root is accepted too. This file needs
 * nothing - not even protobufjs - so the litepack core stays dependency-free.
 *
 * It is a migration, not wire compatibility: the bytes differ, so both sides
 * move together (or a bridge decodes protobuf and re-encodes litepack).
 *
 * Mapping (a note is added wherever it is not exact):
 *   field order       by field number, so a new field with a higher number
 *                     lands at the end - litepack's evolution rule
 *   double/float      float64/float32
 *   int32/sint32      svarint (protobuf spends 10 bytes on a negative int32)
 *   uint32            varint
 *   int64/sint64      svarint;  uint64 → varint   (±2^52 / 2^53: beyond that
 *                     encode throws - pass {wide64: true} for 8-byte int64/uint64)
 *   fixed32/sfixed32  uint32/int32;  fixed64/sfixed64 → uint64/int64
 *   bool/string/bytes bool/string/bytes
 *   message           a named type (recursion works)
 *   enum              enum, when its numbers are 0..n-1; otherwise svarint,
 *                     and the converters translate names ↔ numbers
 *   repeated / map    array / map, optional with an empty default
 *   presence          proto3 implicit scalars → optional with the zero default
 *                     (absent costs nothing, as in protobuf); `optional`,
 *                     messages, proto2 optional → optional; required → required
 *   oneof             a tag field named after the oneof: an enum of its member
 *                     names ('' = none set), with one variant branch per member
 */
(function (root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
    else if (typeof define === 'function' && define.amd) define(factory);
    else root.litepackProto = factory();
})(this, function () {
'use strict';

var MAX_OPTIONAL = 52;   // litepack's optional fields per struct

function fromProto(descriptor, rootName, opts) {
    opts = opts || {};
    var json = descriptor && typeof descriptor.toJSON === 'function' ? descriptor.toJSON() : descriptor;
    if (!json || typeof json !== 'object' || !json.nested) throw new Error('litepack-proto: expected a protobufjs JSON descriptor (root.toJSON() or pbjs -t json)');
    var wide = !!opts.wide64;

    // ── index every message and enum by its full name ──
    var defs = Object.create(null);
    (function index(nested, prefix, edition) {
        for (var k in nested) {
            if (!Object.prototype.hasOwnProperty.call(nested, k)) continue;
            var d = nested[k], full = prefix ? prefix + '.' + k : k, ed = d.edition || edition;
            if (d.fields) defs[full] = { kind: 'message', d: d, name: full, edition: ed };
            else if (d.values) defs[full] = { kind: 'enum', d: d, name: full };
            if (d.nested) index(d.nested, full, ed);
        }
    })(json.nested, '', json.edition || null);

    // protobuf scoping: a name is looked up from the innermost scope outwards
    function resolve(typeName, scope) {
        if (typeName.charAt(0) === '.') { var abs = typeName.slice(1); if (defs[abs]) return defs[abs]; }
        else {
            var parts = scope.split('.');
            for (var i = parts.length; i >= 0; i--) {
                var cand = parts.slice(0, i).concat(typeName).join('.');
                if (defs[cand]) return defs[cand];
            }
        }
        throw new Error("litepack-proto: type '" + typeName + "' (used in " + scope + ') is not in the descriptor - include the .proto that defines it');
    }

    var rootDef = defs[rootName];
    if (!rootDef || rootDef.kind !== 'message') throw new Error("litepack-proto: no message '" + rootName + "' (messages: " + Object.keys(defs).filter(function (k) { return defs[k].kind === 'message'; }).join(', ') + ')');

    var notes = [], types = {}, conv = Object.create(null), done = Object.create(null);
    function note(s) { if (notes.indexOf(s) === -1) notes.push(s); }

    // ── enums ──
    var enums = Object.create(null);
    function enumInfo(def) {
        if (enums[def.name]) return enums[def.name];
        var vals = def.d.values, names = Object.keys(vals), byNum = Object.create(null), dense = true;
        names.sort(function (a, b) { return vals[a] - vals[b]; });
        for (var i = 0; i < names.length; i++) {
            var n = vals[names[i]];
            if (byNum[n] !== undefined) dense = false;       // an alias: two names, one number
            else byNum[n] = names[i];
            if (n !== i) dense = false;
        }
        if (!dense) note("enum " + def.name + ": its numbers are not 0..n-1, so it is stored as an svarint number; the converters translate names");
        return (enums[def.name] = { dense: dense, names: names, values: vals, byNum: byNum, first: names[0] });
    }

    // ── scalars ──
    var SCALAR = {
        'double': 'float64', 'float': 'float32',
        int32: 'svarint', sint32: 'svarint', uint32: 'varint',
        int64: wide ? 'int64' : 'svarint', sint64: wide ? 'int64' : 'svarint', uint64: wide ? 'uint64' : 'varint',
        fixed32: 'uint32', sfixed32: 'int32', fixed64: 'uint64', sfixed64: 'int64',
        bool: 'bool', string: 'string', bytes: 'bytes'
    };
    var IS64 = { int64: 1, sint64: 1, uint64: 1, fixed64: 1, sfixed64: 1 };
    var ZERO = { 'double': 0, 'float': 0, int32: 0, sint32: 0, uint32: 0, int64: 0, sint64: 0, uint64: 0,
                 fixed32: 0, sfixed32: 0, fixed64: 0, sfixed64: 0, bool: false, string: '' };

    function toInt(v, ptype, lpType) {
        // a protobufjs Long, a decimal string, a number or a BigInt
        if (v && typeof v === 'object' && typeof v.low === 'number' && typeof v.high === 'number') {
            var b = (BigInt(v.high >>> 0) << 32n) | BigInt(v.low >>> 0);
            v = v.unsigned ? b : BigInt.asIntN(64, b);
        } else if (typeof v === 'string') v = BigInt(v);
        if (lpType === 'int64' || lpType === 'uint64') return v;                // both take Number or BigInt
        // svarint holds ±(2^52-1), varint 0..2^53-1: say so here, with the way out
        var lim = lpType === 'svarint' ? 4503599627370495 : 9007199254740991;
        if (typeof v === 'bigint') v = v > 9007199254740991n || v < -9007199254740991n ? Infinity : Number(v);
        if (typeof v === 'number' && Math.abs(v) > lim) {
            throw new Error('litepack-proto: ' + ptype + ' value ' + v + ' is beyond what ' + lpType + ' holds (' + (lpType === 'svarint' ? '±2^52' : '2^53') + ') - convert with {wide64: true}');
        }
        return v;
    }
    function toBytes(v) {
        if (v instanceof Uint8Array) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        if (Array.isArray(v)) return Uint8Array.from(v);
        if (typeof v === 'string') {                                         // protobufjs bytes: String → base64
            var bin = typeof atob === 'function' ? atob(v) : Buffer.from(v, 'base64').toString('binary');
            var out = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
        throw new Error('litepack-proto: bytes value of type ' + typeof v);
    }

    // ── one value of a field type: [litepack def tail], to(), from() ──
    function valueCodec(typeName, scope, where) {
        if (SCALAR[typeName]) {
            var lt = SCALAR[typeName];
            if (IS64[typeName] && !wide && (lt === 'svarint' || lt === 'varint')) note(typeName + ' fields are ' + lt + ': compact, up to ' + (lt === 'svarint' ? '±(2^52-1)' : '2^53-1') + ' - larger values throw; {wide64: true} stores 8 bytes instead');
            if (typeName === 'bytes') return { def: ['bytes'], to: toBytes, from: function (v) { return v; }, zero: null };
            if (IS64[typeName] || typeName === 'int32' || typeName === 'sint32' || typeName === 'uint32' || typeName === 'fixed32' || typeName === 'sfixed32') {
                return { def: [lt], to: function (v) { return toInt(v, typeName, lt); }, from: function (v) { return v; }, zero: 0 };
            }
            return { def: [lt], to: function (v) { return v; }, from: function (v) { return v; }, zero: ZERO[typeName] };
        }
        var def = resolve(typeName, scope);
        if (def.kind === 'enum') {
            var e = enumInfo(def);
            if (e.dense) {
                return { def: ['enum', e.names.slice()], enumDense: true,
                         to: function (v) { return typeof v === 'number' ? e.byNum[v] : v; },
                         from: function (v) { return v; }, zero: e.first };
            }
            return { def: ['svarint'],
                     to: function (v) { if (typeof v === 'string') { if (!(v in e.values)) throw new Error('litepack-proto: ' + v + ' is not a value of ' + def.name); return e.values[v]; } return v; },
                     from: function (v) { return e.byNum[v] !== undefined ? e.byNum[v] : v; }, zero: 0 };
        }
        message(def);
        return { def: [def.name], to: function (v) { return conv[def.name].to(v); }, from: function (v) { return conv[def.name].from(v); }, zero: null, isMessage: true };
    }

    // presence: 'required' | 'explicit' | 'implicit'
    function presence(f, edition, isMsg) {
        var feat = f.options && (f.options['features.field_presence'] || (f.options.features && f.options.features.field_presence));
        if (f.rule === 'required' || feat === 'LEGACY_REQUIRED') return 'required';
        if (isMsg || (f.options && f.options.proto3_optional)) return 'explicit';
        if (feat === 'IMPLICIT') return 'implicit';
        if (feat === 'EXPLICIT') return 'explicit';
        if (edition === 'proto2') return 'explicit';
        if (edition && edition !== 'proto3') return 'explicit';              // editions: explicit by default
        return 'implicit';                                                   // proto3
    }

    // ── a message: its litepack field list and converters ──
    function message(def) {
        if (done[def.name]) return;
        done[def.name] = true;
        conv[def.name] = { to: null, from: null };                           // filled below; recursion finds it

        var d = def.d, scope = def.name;
        if (d.extensions) note('message ' + def.name + ': extensions are not carried over');
        var oneofOf = Object.create(null), oneofs = d.oneofs || {};
        for (var o in oneofs) {
            var mem = oneofs[o].oneof;
            var synthetic = mem.length === 1 && d.fields[mem[0]] && d.fields[mem[0]].options && d.fields[mem[0]].options.proto3_optional;
            if (!synthetic) for (var j = 0; j < mem.length; j++) oneofOf[mem[j]] = o;
        }
        var names = Object.keys(d.fields).sort(function (a, b) { return d.fields[a].id - d.fields[b].id; });
        var out = [], steps = [], optionals = 0, seenOneof = Object.create(null);

        function optSlot() { if (optionals < MAX_OPTIONAL) { optionals++; return true; } return false; }

        for (var i = 0; i < names.length; i++) {
            var name = names[i], f = d.fields[name];
            if (f.type === 'group' || f.resolvedType === 'group') throw new Error('litepack-proto: groups are not supported (' + scope + '.' + name + ')');

            if (oneofOf[name]) {
                var oname = oneofOf[name];
                if (seenOneof[oname]) continue;
                seenOneof[oname] = true;
                var members = oneofs[oname].oneof.slice().sort(function (a, b) { return d.fields[a].id - d.fields[b].id; });
                var variants = { '': [] }, mconv = {};
                members.forEach(function (m) {
                    var vc = valueCodec(d.fields[m].type, scope, scope + '.' + m);
                    variants[m] = [[m].concat(vc.def)];
                    mconv[m] = vc;
                });
                out.push([oname, 'enum', [''].concat(members), { variants: variants }]);
                note('oneof ' + scope + '.' + oname + ": a tag field '" + oname + "' (enum of the member names, '' = none) with one variant per member");
                steps.push({ oneof: oname, members: members, mconv: mconv });
                continue;
            }

            var rule = f.keyType ? 'map' : f.rule === 'repeated' ? 'repeated' : null;
            var vc2 = valueCodec(f.type, scope, scope + '.' + name);
            var pres = rule ? 'repeated' : presence(f, def.edition, vc2.isMessage);
            var fd, step = { name: name, vc: vc2, rule: rule, pres: pres };

            if (rule === 'map') {
                var kt = f.keyType === 'bool' ? 'string' : SCALAR[f.keyType];
                if (f.keyType === 'bool') note('map ' + scope + '.' + name + ': bool keys are stored as the strings "true"/"false"');
                var vdef = vc2.def;
                if (vc2.enumDense) { vdef = ['varint']; step.mapEnumAsIndex = true; note('map ' + scope + '.' + name + ': enum values are stored as their index'); }
                fd = [name, 'map', kt].concat(vdef);
            } else if (rule === 'repeated') {
                fd = [name, 'array'].concat(vc2.def);
            } else {
                fd = [name].concat(vc2.def);
            }

            if (pres !== 'required') {
                if (optSlot()) {
                    fd[1] = fd[1] + '?';
                    // the value decode gives when absent - protobuf's default
                    var dflt = null;
                    if (rule === 'map') dflt = {};
                    else if (rule === 'repeated') dflt = [];
                    else if (pres === 'implicit' && vc2.zero !== null) dflt = vc2.zero;
                    else if (f.options && f.options['default'] !== undefined && !vc2.isMessage) dflt = vc2.to(f.options['default']);
                    if (dflt !== null) fd.push({ 'default': dflt });
                } else {
                    step.forced = true;                                     // over 52 optionals: always written
                    note('message ' + scope + ': more than ' + MAX_OPTIONAL + ' optional fields - ' + name + ' and later ones are always written');
                }
            }
            out.push(fd);
            steps.push(step);
        }
        types[def.name] = out;

        function isZero(v, step) {
            if (step.rule === 'repeated') return !v || v.length === 0;
            if (step.rule === 'map') return !v || Object.keys(v).length === 0;
            if (step.pres !== 'implicit') return v === undefined || v === null;
            if (v === undefined || v === null) return true;
            if (step.vc.zero === null) return v.length === 0;                // bytes
            var n = step.vc.to(v);                                           // Long, '0', 0n → 0
            return n === step.vc.zero || n === 0n;
        }

        conv[def.name].to = function (obj) {
            var r = {};
            for (var s = 0; s < steps.length; s++) {
                var st = steps[s];
                if (st.oneof) {
                    var which = typeof obj[st.oneof] === 'string' ? obj[st.oneof] : '';
                    if (!which) for (var q = 0; q < st.members.length; q++) if (obj[st.members[q]] !== undefined && obj[st.members[q]] !== null) { which = st.members[q]; break; }
                    r[st.oneof] = which;
                    if (which) r[which] = st.mconv[which].to(obj[which]);
                    continue;
                }
                var v = obj[st.name];
                if (st.pres !== 'required' && !st.forced && isZero(v, st)) continue;   // absent: zero bytes, as in protobuf
                if (st.rule === 'repeated') r[st.name] = (v || []).map(st.vc.to);
                else if (st.rule === 'map') {
                    var m = {};
                    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) {
                        var mv = st.vc.to(v[k]);
                        m[k] = st.mapEnumAsIndex ? st.vc.def[1].indexOf(mv) : mv;
                    }
                    r[st.name] = m;
                }
                else if (v === undefined || v === null) {
                    // a required (or forced) field the object lacks: protobuf's zero value
                    r[st.name] = st.vc.isMessage ? st.vc.to({}) : st.vc.zero !== null ? st.vc.to(st.vc.zero) : new Uint8Array(0);
                }
                else r[st.name] = st.vc.to(v);
            }
            return r;
        };
        conv[def.name].from = function (data) {
            var r = {};
            for (var s = 0; s < steps.length; s++) {
                var st = steps[s];
                if (st.oneof) {
                    var which = data[st.oneof];
                    if (which) { r[which] = st.mconv[which].from(data[which]); r[st.oneof] = which; }
                    continue;
                }
                var v = data[st.name];
                if (v === undefined) continue;
                if (st.rule === 'repeated') r[st.name] = v.map(st.vc.from);
                else if (st.rule === 'map') {
                    var m = {};
                    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) m[k] = st.vc.from(st.mapEnumAsIndex ? st.vc.def[1][v[k]] : v[k]);
                    r[st.name] = m;
                }
                else r[st.name] = st.vc.from(v);
            }
            return r;
        };
    }

    message(rootDef);
    var rootFields = types[rootDef.name];
    var schema = { fields: rootFields, types: types };
    var decodeOptions = wide ? { bigint: true } : {};      // 8-byte ints beyond 2^53 come back as BigInt
    var self = {
        schema: schema,
        rootType: rootDef.name,
        decodeOptions: decodeOptions,
        toLitepack: function (obj) { return conv[rootDef.name].to(obj || {}); },
        fromLitepack: function (data) { return conv[rootDef.name].from(data || {}); },
        /* shortcuts, given litepack: a protobufjs object ↔ litepack bytes */
        encode: function (lp, obj) { return lp.encode(schema, self.toLitepack(obj)); },
        decode: function (lp, bytes) { return self.fromLitepack(lp.decode(schema, bytes, decodeOptions)); },
        notes: notes
    };
    return self;
}

return { fromProto: fromProto, version: '0.1.0' };
});
