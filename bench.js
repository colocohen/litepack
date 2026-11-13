/*
 * Benchmark: node bench.js old.js new.js — the same messages through both builds.
 * Every case uses data that is valid under both versions.
 */
'use strict';
var paths = process.argv.slice(2);
var libs = paths.map(function (p) { return require(require('path').resolve(p)); });

var cases = [
    { name: 'mixed message (ints + string + array)',
      schema: [['id', 'varint'], ['name', 'string'], ['vals', 'array', 'varint'], ['ok', 'bool'], ['t', 'uint32']],
      data: { id: 918273645, name: 'peer-x1', vals: [1, 22, 333, 4444, 55555], ok: true, t: 123456 } },
    { name: 'enum + set',
      schema: [['status', 'enum', ['active', 'inactive', 'banned']], ['perms', 'set', ['read', 'write', 'execute', 'admin']], ['n', 'varint']],
      data: { status: 'banned', perms: ['read', 'execute'], n: 7 } },
    { name: '5 structs with nested arrays',
      schema: [['streams', 'array', 'struct', [['streamId', 'varint'], ['fromPeer', 'varint'], ['toPeers', 'array', 'varint']]]],
      data: { streams: [1, 2, 3, 4, 5].map(function (i) { return { streamId: i, fromPeer: i * 10, toPeers: [i, i + 1, i + 2] }; }) } },
    { name: 'optionals (2 of 4 present) + bits',
      schema: [['id', 'varint'], ['email', 'string?'], ['age', 'uint8?'], ['nick', 'string?'], ['score', 'varint?'],
               ['flags', 'bits', [['active', 1], ['mode', 3], ['quality', 4]]]],
      data: { id: 300, email: 'a@b.c', score: 99, flags: { active: 1, mode: 5, quality: 12 } } },
    { name: 'transaction-like (fixed 32 + arrays of structs)',
      schema: [['parent', 'fixed', 32], ['signers', 'array', 'struct', [['pubkey', 'fixed', 32], ['ranges', 'array', 'struct', [['gap', 'varint'], ['len', 'varint']]]]],
               ['segments', 'array', 'struct', [['to', 'uint8'], ['len', 'varint']]]],
      data: { parent: new Uint8Array(32), signers: [{ pubkey: new Uint8Array(32).fill(7), ranges: [{ gap: 1099511627776, len: 50000 }] }], segments: [{ to: 0, len: 50000 }] } },
    { name: 'uint64 small values',
      schema: [['a', 'uint64'], ['b', 'uint64'], ['c', 'int64']],
      data: { a: 12345, b: 4000000000, c: -5 } },
    { name: 'map, 5 string keys (sorted already)',
      schema: [['m', 'map', 'string', 'varint']],
      data: { m: { alpha: 1, beta: 2, delta: 3, gamma: 4, omega: 5 } } },
    { name: 'map, 5 string keys (unsorted)',
      schema: [['m', 'map', 'string', 'varint']],
      data: { m: { omega: 5, beta: 2, gamma: 4, alpha: 1, delta: 3 } } },
    { name: 'json field',
      schema: [['meta', 'json']],
      data: { meta: { z: 1, a: [1, 2, 3], m: { y: 'x', b: true } } } }
];

function rate(fn) {
    var n = 0, t0 = process.hrtime.bigint(), lim = 250000000n;   /* 250 ms */
    while (process.hrtime.bigint() - t0 < lim) { for (var i = 0; i < 200; i++) { fn(); } n += 200; }
    return n / (Number(process.hrtime.bigint() - t0) / 1e9);
}
function fmt(x) { return x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : (x / 1e3).toFixed(0) + 'K'; }

cases.forEach(function (c) {
    var bufs = libs.map(function (lp) { return lp.encode(c.schema, c.data); });
    var res = libs.map(function (lp, i) { return { enc: 0, dec: 0, bytes: bufs[i].length }; });
    for (var r = 0; r < 5; r++) {   /* best of 5, the builds interleaved round by round */
        libs.forEach(function (lp, i) {
            res[i].enc = Math.max(res[i].enc, rate(function () { lp.encode(c.schema, c.data); }));
            res[i].dec = Math.max(res[i].dec, rate(function () { lp.decode(c.schema, bufs[i]); }));
        });
    }
    var line = c.name.padEnd(48);
    res.forEach(function (r, i) { line += '  [' + (i ? 'new' : 'old') + '] enc ' + fmt(r.enc).padStart(6) + ' dec ' + fmt(r.dec).padStart(6) + ' (' + r.bytes + 'B)'; });
    if (res.length === 2) {
        line += '  Δenc ' + ((res[1].enc / res[0].enc - 1) * 100).toFixed(0) + '%  Δdec ' + ((res[1].dec / res[0].dec - 1) * 100).toFixed(0) + '%';
    }
    console.log(line);
});
