/* The README size table: node bench-sizes.js (npm i protobufjs @msgpack/msgpack) */
var lp = require('./litepack.js'), mp = require('@msgpack/msgpack'), pb = require('protobufjs'), crypto = require('crypto');
var J = function (o) { return Buffer.byteLength(JSON.stringify(o, function (k, v) { return v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v; })); };
var R = pb.Root.fromJSON({ nested: {
  User: { fields: { id: { type: 'uint64', id: 1 }, name: { type: 'string', id: 2 }, status: { type: 'int32', id: 3 }, roles: { rule: 'repeated', type: 'int32', id: 4 }, age: { type: 'uint32', id: 5 }, email: { type: 'string', id: 6 } } },
  Reading: { fields: { t: { type: 'uint64', id: 1 }, temp: { type: 'float', id: 2 }, ok: { type: 'bool', id: 3 } } },
  Batch: { fields: { r: { rule: 'repeated', type: 'Reading', id: 1 } } },
  Flags: { fields: { f: { rule: 'repeated', type: 'bool', id: 1 } } },
  Pos: { fields: { id: { type: 'uint32', id: 1 }, x: { type: 'float', id: 2 }, y: { type: 'float', id: 3 }, hp: { type: 'uint32', id: 4 }, team: { type: 'uint32', id: 5 }, alive: { type: 'bool', id: 6 } } },
  World: { fields: { p: { rule: 'repeated', type: 'Pos', id: 1 } } }
}});
function pbs(t, o) { var T = R.lookupType(t); return T.encode(T.fromObject(o)).finish().length; }
function row(name, json, lpb, pbt, pbo) { console.log('| ' + name + ' | ' + J(json) + ' | ' + mp.encode(json).length + ' | ' + pbs(pbt, pbo) + ' | **' + lpb + '** |'); }

var user = { id: 123456, name: 'Aviv Cohen', status: 'active', roles: ['admin', 'user'], age: 34, email: 'aviv@example.com' };
row('User record (enum, set, optional)', user, lp.encode([['id','varint'],['name','string'],['status','enum',['active','inactive','banned']],['roles','set',['admin','user','guest']],['age','uint8'],['email','string?']], user).length,
    'User', { id: 123456, name: user.name, status: 0, roles: [0, 1], age: 34, email: user.email });
var t0 = 1763000000000, rd = []; for (var i = 0; i < 20; i++) rd.push({ t: t0 + i * 1000, temp: [21.5, 21.6, 21.4, 21.8][i % 4], ok: i % 7 !== 3 });
var cols = { t: rd.map(function (r) { return r.t; }), temp: rd.map(function (r) { return Math.round(r.temp * 10); }), ok: rd.map(function (r) { return r.ok; }) };
row('20 sensor readings (row per reading)', { r: rd }, lp.encode([['r','array','struct',[['t','timestamp'],['temp','float32'],['ok','bool']]]], { r: rd }).length, 'Batch', { r: rd });
row('20 sensor readings (deltas + bitset)', { r: rd }, lp.encode([['t','deltas'],['temp','deltas'],['ok','bitset']], cols).length, 'Batch', { r: rd });
var fl = []; for (i = 0; i < 64; i++) fl.push(i % 3 === 0);
row('64 booleans (bitset)', { f: fl }, lp.encode([['f','bitset']], { f: fl }).length, 'Flags', { f: fl });
var w = []; for (i = 0; i < 10; i++) w.push({ id: i + 1, x: 100 + i * 77.5, y: 900 - i * 31.25, hp: 50 + i * 5, team: i % 4, alive: i % 5 !== 0 });
row('Game state, 10 players (bits)', { p: w }, lp.encode([['p','array','struct',[['id','varint'],['x','float32'],['y','float32'],['s','bits',[['hp',7],['team',2],['alive',1]]]]]], { p: w.map(function (o) { return { id: o.id, x: o.x, y: o.y, s: { hp: o.hp, team: o.team, alive: o.alive ? 1 : 0 } }; }) }).length, 'World', { p: w });

/* the two classic protobuf examples, converted with litepack-proto */
var lpProto = require('./litepack-proto.js');
var AB = pb.parse('syntax = "proto3"; package tutorial; message Person { string name = 1; int32 id = 2; string email = 3; enum PhoneType { MOBILE = 0; HOME = 1; WORK = 2; } message PhoneNumber { string number = 1; PhoneType type = 2; } repeated PhoneNumber phones = 4; int64 last_updated = 5; } message AddressBook { repeated Person people = 1; }', { keepCase: true }).root;
var book = { people: [
    { name: 'John Doe', id: 1234, email: 'jdoe@example.com', phones: [{ number: '555-4321', type: 'HOME' }], last_updated: 1763000000 },
    { name: 'Jane Roe', id: 1235, email: 'jane.roe@example.org', phones: [{ number: '555-1111' }, { number: '555-2222', type: 'WORK' }], last_updated: 1763000500 },
    { name: 'Avi Levi', id: 1236, last_updated: 1763001200 }] };
var MC = pb.parse('syntax = "proto3"; message Image { string uri = 1; string title = 2; int32 width = 3; int32 height = 4; enum Size { SMALL = 0; LARGE = 1; } Size size = 5; } message Media { string uri = 1; string title = 2; int32 width = 3; int32 height = 4; string format = 5; int64 duration = 6; int64 size = 7; int32 bitrate = 8; repeated string persons = 9; enum Player { JAVA = 0; FLASH = 1; } Player player = 10; string copyright = 11; } message MediaContent { repeated Image images = 1; Media media = 2; }').root;
var media = { media: { uri: 'http://javaone.com/keynote.mpg', title: 'Javaone Keynote', width: 640, height: 480, format: 'video/mpg4', duration: 18000000, size: 58982400, bitrate: 262144, persons: ['Bill Gates', 'Steve Jobs'], player: 'JAVA' },
    images: [{ uri: 'http://javaone.com/keynote_large.jpg', title: 'Javaone Keynote', width: 1024, height: 768, size: 'LARGE' }, { uri: 'http://javaone.com/keynote_small.jpg', title: 'Javaone Keynote', width: 320, height: 240, size: 'SMALL' }] };
[[AB, 'tutorial.AddressBook', book, 'AddressBook (protobuf tutorial, 3 people)'], [MC, 'MediaContent', media, 'MediaContent (jvm-serializers benchmark)']].forEach(function (c) {
    var T = c[0].lookupType(c[1]), m = lpProto.fromProto(c[0], c[1]), pbBytes = T.encode(T.fromObject(c[2])).finish();
    console.log('| ' + c[3] + ' | ' + J(c[2]) + ' | ' + mp.encode(c[2]).length + ' | ' + pbBytes.length + ' | **' + m.encode(lp, T.toObject(T.decode(pbBytes))).length + '** |');
});
