/**
 * litepack 2.0 — type declarations.
 *
 * Declare a schema `as const` and the data type follows from it:
 *
 *   const User = [['id', 'varint'], ['name', 'string'], ['email', 'string?']] as const;
 *   litepack.encode(User, { id: 1, name: 'Aviv' });          // ✓
 *   litepack.encode(User, { id: 1 });                         // ✗ name is missing
 *   const u = litepack.decode(User, buf);                     // { id: number; name: string; email?: string }
 *
 * A schema without `as const` still works; its data is then typed loosely
 * (Record<string, any>), as in 1.x.
 */

declare namespace litepack {
    // ── Schemas ─────────────────────────────────────────────────────────

    /** Built-in types that take no definition. */
    type ScalarType =
        | 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32' | 'uint64' | 'int64'
        | 'float32' | 'float64' | 'bool' | 'varint' | 'svarint' | 'timestamp'
        | 'string' | 'bytes' | 'uint8s' | 'tail' | 'uuid' | 'json'
        | 'ascending' | 'deltas' | 'bitset';

    /** Types followed by a definition: enum names, struct fields, item type… */
    type CompoundType = 'enum' | 'set' | 'bits' | 'fixed' | 'struct' | 'array' | 'map' | 'const';

    /** The options object — always the last element of a field. */
    interface FieldOptions {
        /** May be absent — the same as a type ending in '?'. */
        optional?: boolean;
        /** What decode gives when an optional field is absent. */
        default?: unknown;
        /** Bounds: the length/count of a string, bytes, array, map, ascending, deltas, bitset
            (a `chars` string: its character count), or the value of a number. */
        min?: number | bigint;
        max?: number | bigint;
        /** strings only: the allowed characters ('a-z0-9_.'); each takes ceil(log2 N) bits. */
        chars?: string;
        /** arrays only: a fixed length, not written on the wire. */
        count?: number;
        /** A tagged union: the tag's value (as a string; an enum's name) picks a branch,
            whose fields follow it and land in the same object. */
        variants?: { readonly [tag: string]: FieldList };
    }

    /**
     * [name, type, ...definition, options?]
     *
     *   ['id', 'varint']                                  ['tags', 'array', 'string', { max: 16 }]
     *   ['email', 'string?']                              ['rgb', 'array', 'uint8', { count: 3 }]
     *   ['status', 'enum', ['on', 'off']]                 ['meta', 'map', 'string', 'varint']
     *   ['perms', 'set', ['r', 'w', 'x']]                 ['peers', 'map', 'varint', 'struct', [...]]
     *   ['flags', 'bits', [['on', 1], ['mode', 3]]]       ['v', 'const', 'uint8', 2]
     *   ['hash', 'fixed', 32]                             ['user', 'string', { chars: 'a-z0-9_', max: 20 }]
     *   ['pos', 'struct', [['x', 'svarint'], ...]]        ['kind', 'uint8', { variants: { '1': [...] } }]
     *   ['root', 'Node']                                  — a named type (object schemas)
     */
    type Field = readonly [name: string, type: string, ...rest: readonly unknown[]];
    type FieldList = readonly Field[];

    /** A schema with named types; a name may refer to itself (trees, lists). */
    interface ObjectSchema {
        readonly fields: FieldList;
        readonly types?: { readonly [name: string]: FieldList };
        /** How deep a recursive type may nest on encode and decode (default 100). */
        readonly maxDepth?: number;
    }

    type Schema = FieldList | ObjectSchema;

    // ── Data types inferred from a schema ───────────────────────────────

    interface Scalars {
        uint8: number; int8: number; uint16: number; int16: number; uint32: number; int32: number;
        /** A Number, or a BigInt (always a BigInt when decoded with {bigint: true}). */
        uint64: number | bigint; int64: number | bigint;
        float32: number; float64: number; bool: boolean;
        varint: number; svarint: number; timestamp: number;
        string: string; bytes: Uint8Array; uint8s: Uint8Array; tail: Uint8Array; uuid: Uint8Array;
        json: unknown;
        ascending: number[]; deltas: number[]; bitset: boolean[];
    }

    type Base<T> = T extends `${infer B}?` ? B : T;
    type Last<F> = F extends readonly [...unknown[], infer L] ? L : never;
    type OptionsOf<F> = Last<F> extends readonly unknown[] ? {} : Last<F> extends object ? Last<F> : {};
    type IsOptional<F> = F extends readonly [string, `${string}?`, ...unknown[]] ? true
        : OptionsOf<F> extends { optional: true } ? true : false;
    type IsConst<F> = F extends readonly [string, 'const', ...unknown[]] ? true : false;
    type IsTag<F> = OptionsOf<F> extends { variants: object } ? true : false;
    type Simplify<T> = { [K in keyof T]: T[K] } & {};

    type BitsObject<D> = D extends readonly (readonly [string, number])[]
        ? { [S in D[number] as S[0]]: number | boolean } : Record<string, number | boolean>;

    /** The value of one type, given what follows it in the field (R) and the named types (T). */
    type ValueOf<B, R, T> =
        B extends 'enum' ? (R extends readonly [infer O extends readonly string[], ...unknown[]] ? O[number] : string) :
        B extends 'set' ? (R extends readonly [infer O extends readonly string[], ...unknown[]] ? O[number][] : string[]) :
        B extends 'bits' ? (R extends readonly [infer D, ...unknown[]] ? BitsObject<D> : Record<string, number | boolean>) :
        B extends 'fixed' ? Uint8Array :
        B extends 'struct' ? (R extends readonly [infer S extends FieldList, ...unknown[]] ? DataOf<S, T> : Record<string, unknown>) :
        B extends 'array' ? (R extends readonly [infer I extends string, ...infer R2] ? ValueOf<Base<I>, R2, T>[] : unknown[]) :
        B extends 'map' ? (R extends readonly [string, infer V extends string, ...infer R2] ? { [key: string]: ValueOf<V, R2, T> } : Record<string, unknown>) :
        B extends 'const' ? (R extends readonly [string, infer C, ...unknown[]] ? C : unknown) :
        B extends keyof Scalars ? Scalars[B] :
        B extends keyof T ? (T[B] extends FieldList ? DataOf<T[B], T> : unknown) :
        unknown;                                                     // a custom codec

    type FieldValue<F, T> = F extends readonly [string, infer Ty, ...infer R] ? ValueOf<Base<Ty>, R, T> : unknown;

    /** A variant tag's value for a branch key: a number for integer tags, the key for string/enum tags. */
    type TagValue<K, B> =
        B extends 'string' | 'enum' ? K :
        B extends 'bool' ? (K extends 'true' ? true : false) :
        K extends `${infer N extends number}` ? N : never;

    type VariantOf<F, T> =
        F extends readonly [infer N extends string, infer Ty, ...unknown[]]
            ? OptionsOf<F> extends { variants: infer V }
                ? { [K in keyof V & string]: { [P in N]: TagValue<K, Base<Ty>> } & (V[K] extends FieldList ? DataOf<V[K], T> : {}) }[keyof V & string]
                : unknown
            : unknown;
    type VariantsOf<S, T> = S extends readonly [infer H, ...infer Rest] ? VariantOf<H, T> & VariantsOf<Rest, T> : unknown;

    /** The data object of a field list. */
    type DataOf<S extends FieldList, T> =
        Simplify<
            { [F in S[number] as IsOptional<F> extends true ? never : IsConst<F> extends true ? never : IsTag<F> extends true ? never : F[0]]: FieldValue<F, T> } &
            { [F in S[number] as IsTag<F> extends true ? never : IsOptional<F> extends true ? F[0] : IsConst<F> extends true ? F[0] : never]?: FieldValue<F, T> }
        > & VariantsOf<S, T>;

    /** The data type a schema describes — `Record<string, any>` when the schema is not `as const`. */
    type Infer<S> =
        S extends FieldList ? (string extends S[number][0] ? Record<string, any> : DataOf<S, {}>) :
        S extends ObjectSchema ? (string extends S['fields'][number][0] ? Record<string, any> : DataOf<S['fields'], NonNullable<S['types']>>) :
        Record<string, any>;

    // ── Options, handles, errors ────────────────────────────────────────

    interface DecodeOptions {
        /** For schemas that evolve: tolerate trailing bytes, and optional bits, enum
            indices, set bits and variants from a newer peer. Needs an optional field. */
        extensible?: boolean;
        /** uint64/int64 always decode to BigInt (otherwise a Number; beyond 2^53 throws). */
        bigint?: boolean;
        /** Copy the input once, so decoded bytes/fixed/uuid/tail are not views into it. */
        copy?: boolean;
    }

    interface CompileOptions {
        extensible?: boolean;
        bigint?: boolean;
    }

    interface Compiled<D> {
        encode(data: D): Uint8Array;
        decode(buf: Uint8Array | ArrayBuffer, opts?: DecodeOptions): D;
        tryDecode(buf: Uint8Array | ArrayBuffer, opts?: DecodeOptions): D | null;
        byteLength(data: D): number;
    }

    interface Codec<T = unknown> {
        /** Must be deterministic: the same value, the same bytes. */
        encode(value: T): Uint8Array;
        decode(buf: Uint8Array): T;
        /** Exact encoded size, to skip the sizing encode. */
        estimateSize?(value: T): number;
    }

    type ErrorCode =
        | 'SCHEMA'     // the schema itself is invalid (compile time)
        | 'TYPE'       // encode: a value of the wrong JS type (a TypeError)
        | 'RANGE'      // a number outside what its type holds
        | 'MISSING'    // encode: a required field or bits subfield is absent
        | 'INVALID'    // encode: a value the type cannot carry
        | 'UNKNOWN'    // an enum/set/variant value or optional bit the schema lacks
        | 'LIMIT'      // outside {min, max}, or deeper than maxDepth
        | 'TRUNCATED'  // decode: the input ends early
        | 'TRAILING'   // decode: bytes after the message
        | 'MALFORMED'  // decode: bytes no encoder writes
        | 'CODEC'      // a custom codec encoded one value two ways
        | 'BUFFER';    // encodeInto: the buffer is too small

    /** What every litepack error carries. */
    interface LitepackError extends Error {
        code: ErrorCode;
        /** Where it happened: 'signers[1].ranges', 'meta["lang"]'. */
        path?: string;
        /** Decode: more bytes might complete the message (stream parsing). */
        truncated?: boolean;
    }

    interface Reader {
        offset: number;
        /** Decode the next message and advance. @throws on malformed input */
        read<S extends Schema>(schema: S): Infer<S>;
        /** Like read(), but null on malformed input; the cursor stays. */
        tryRead<S extends Schema>(schema: S): Infer<S> | null;
        /** Decode without advancing. */
        peek<S extends Schema>(schema: S): Infer<S>;
        /** Advance n bytes (past a foreign message). */
        skip(n: number): Reader;
        remaining(): number;
        eof(): boolean;
    }

    interface Writer {
        /** Queue a message; chainable. */
        write<S extends Schema>(schema: S, data: Infer<S>): Writer;
        /** Splice in bytes encoded elsewhere; chainable. */
        raw(bytes: Uint8Array): Writer;
        /** Total size so far, without encoding. */
        byteLength(): number;
        /** One exactly-sized buffer. @throws like encode */
        bytes(): Uint8Array;
    }
}

declare const litepack: {
    /** Encode data to bytes. @throws {litepack.LitepackError} on anything it would have to guess */
    encode<const S extends litepack.Schema>(schema: S, data: litepack.Infer<S>): Uint8Array;

    /** Decode bytes — only the exact bytes encode writes. @throws {litepack.LitepackError} */
    decode<const S extends litepack.Schema>(schema: S, buf: Uint8Array | ArrayBuffer, opts?: litepack.DecodeOptions): litepack.Infer<S>;

    /** Like decode, but null on malformed input — the call for network data. */
    tryDecode<const S extends litepack.Schema>(schema: S, buf: Uint8Array | ArrayBuffer, opts?: litepack.DecodeOptions): litepack.Infer<S> | null;

    /** Compile once into a bound handle; options apply to every decode through it. */
    compile<const S extends litepack.Schema>(schema: S, opts?: litepack.CompileOptions): litepack.Compiled<litepack.Infer<S>>;

    /** Exact encoded size, without encoding. */
    byteLength<const S extends litepack.Schema>(schema: S, data: litepack.Infer<S>): number;

    /** Decode one message at `offset`; trailing bytes are left alone. */
    decodeFrom<const S extends litepack.Schema>(schema: S, buf: Uint8Array | ArrayBuffer, offset?: number, opts?: litepack.DecodeOptions): { value: litepack.Infer<S>; bytesRead: number };

    /** Encode into `buf` at `offset`; returns the bytes written. @throws BUFFER if it will not fit */
    encodeInto<const S extends litepack.Schema>(schema: S, data: litepack.Infer<S>, buf: Uint8Array, offset?: number): number;

    /** Concatenate byte arrays (one allocation). */
    concat(list: Uint8Array[]): Uint8Array;

    /** A cursor over messages one after another in one buffer. */
    reader(buf: Uint8Array | ArrayBuffer, opts?: litepack.DecodeOptions): litepack.Reader;

    /** Build one buffer from several messages: writer().write(a, x).write(b, y).bytes() */
    writer(): litepack.Writer;

    /** The schema's id: MurmurHash3-32 of schemaBytes(schema), 0 … 2^32−1. */
    schemaId(schema: litepack.Schema): number;

    /** The bytes schemaId hashes — hash them with any other function. */
    schemaBytes(schema: litepack.Schema): Uint8Array;

    /** Register a custom type (built-in names are refused). */
    codec<T>(name: string, codec: litepack.Codec<T>): void;

    version: string;
};

export = litepack;
