/**
 * litepack — Lightweight binary schema encoding
 * Type declarations for editor autocomplete / TypeScript consumers.
 */

declare namespace litepack {
    /** Scalar wire types */
    type ScalarType =
        | 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32'
        | 'uint64' | 'int64'
        | 'float32' | 'float64'
        | 'bool'
        | 'varint' | 'svarint' | 'timestamp'
        | 'string' | 'bytes' | 'uint8s' | 'tail' | 'json' | 'uuid'
        | string; // custom codec names registered via litepack.codec()

    /** Any type name, optionally suffixed with '?' for optional fields */
    type FieldType = ScalarType | `${ScalarType}?`
        | 'bits' | 'bits?' | 'enum' | 'enum?' | 'set' | 'set?'
        | 'fixed' | 'fixed?' | 'struct' | 'struct?' | 'array' | 'array?'
        | 'map' | 'map?' | 'const';

    /** Options object allowed as the LAST element of a field def */
    interface FieldOptions { default?: unknown; }

    /** Options accepted by decode / tryDecode / decodeFrom / reader */
    interface DecodeOptions {
        /** Clone the input once so decoded bytes/fixed/uuid/tail views are
            detached from the caller's buffer (safe to recycle it). */
        copy?: boolean;
    }

    type BitsDef = Array<[name: string, width: number]>;
    type VariantsDef = { [discriminatorValue: string]: Schema };

    /**
     * A field definition:
     *   ['name', 'varint']                          — scalar
     *   ['name', 'enum', ['a','b','c']]             — enum
     *   ['name', 'set', ['r','w','x']]              — set (≤ 52 options)
     *   ['name', 'bits', [['on',1],['mode',3]]]     — bitfield
     *   ['name', 'fixed', 32]                       — fixed-length bytes
     *   ['name', 'struct', Schema]                  — nested struct
     *   ['name', 'array', 'uint16']                 — variable array
     *   ['name', 'array', 'uint8', 3]               — fixed-count array
     *   ['name', 'array', 'struct', Schema]         — array of structs
     *   ['name', 'uint8', { '1': Schema, ... }]     — tagged union (variants)
     */
    type Field = [name: string, type: FieldType, def?: unknown, extra?: unknown];
    type Schema = Field[];

    interface Codec<T = unknown> {
        encode(value: T): Uint8Array;
        decode(buf: Uint8Array): T;
        /** Optional: exact encoded size without encoding (perf) */
        estimateSize?(value: T): number;
    }

    interface CompiledSchema<T extends object = Record<string, unknown>> {
        encode(data: T): Uint8Array;
        /** @throws on malformed/truncated input */
        decode(buf: Uint8Array | ArrayBuffer): T;
        /** Exact encoded byte length of `data`, without encoding */
        byteLength(data: T): number;
    }
}

declare const litepack: {
    /**
     * Encode a JavaScript object to bytes.
     * @throws on invalid data: unknown enum/set values, negative varint,
     *         varint above 2^53-1. Missing optional fields cost zero bytes.
     */
    encode(schema: litepack.Schema, data: object): Uint8Array;

    /**
     * Decode bytes back to an object.
     * @throws on malformed input: truncation, oversized declared lengths,
     *         varint bombs, impossible array counts. Safe for hostile wire data.
     */
    decode<T extends object = Record<string, unknown>>(
        schema: litepack.Schema,
        buf: Uint8Array | ArrayBuffer,
        opts?: litepack.DecodeOptions
    ): T;

    /**
     * Like decode(), but returns null on malformed input instead of throwing.
     * Recommended for untrusted network data:
     *   const msg = litepack.tryDecode(proto, wireBytes);
     *   if (!msg) return; // drop malformed message
     */
    tryDecode<T extends object = Record<string, unknown>>(
        schema: litepack.Schema,
        buf: Uint8Array | ArrayBuffer,
        opts?: litepack.DecodeOptions
    ): T | null;

    /** Pre-compile a schema into a bound { encode, decode, byteLength } handle. */
    compile<T extends object = Record<string, unknown>>(
        schema: litepack.Schema
    ): litepack.CompiledSchema<T>;

    /** Exact encoded size of `data` under `schema`, without encoding. */
    byteLength(schema: litepack.Schema, data: object): number;

    /**
     * Throw if any non-optional field is missing (undefined/null), recursing
     * into structs. Use before encoding canonical/signed bytes, where a
     * silently-empty field would still produce a valid-looking signature.
     */
    assertComplete(schema: litepack.Schema, data: object): true;

    /** Register a custom codec usable as a schema field type. */
    codec<T>(name: string, codec: litepack.Codec<T>): void;

    /** Decode one message at `offset`; returns { value, bytesRead }. Trailing bytes untouched. */
    decodeFrom<T extends object = Record<string, unknown>>(
        schema: litepack.Schema, buf: Uint8Array | ArrayBuffer, offset?: number,
        opts?: litepack.DecodeOptions
    ): { value: T; bytesRead: number };

    /** Decode errors from truncated input carry `truncated: true` — meaning
        more bytes might complete the message (raw TCP streaming). Malformed
        errors do not. */

    /** Encode into an existing buffer at `offset`; returns bytes written. @throws if it won't fit */
    encodeInto(schema: litepack.Schema, data: object, buf: Uint8Array, offset?: number): number;

    /** Concatenate Uint8Arrays (single allocation) */
    concat(list: Uint8Array[]): Uint8Array;

    /** Sequential reading cursor over chained messages */
    reader(buf: Uint8Array | ArrayBuffer, opts?: litepack.DecodeOptions): litepack.Reader;

    /** Chained-message builder: writer().write(a,d1).write(b,d2).bytes() */
    writer(): litepack.Writer;

    version: string;
};

export = litepack;

// ── Streaming / composition (chained messages) ──────────────────────────
declare namespace litepack {
    interface Reader {
        offset: number;
        /** Decode next message and advance. @throws on malformed input */
        read<T extends object = Record<string, unknown>>(schema: Schema): T;
        /** Like read(), but returns null on malformed input; cursor not advanced */
        tryRead<T extends object = Record<string, unknown>>(schema: Schema): T | null;
        /** Decode without advancing */
        peek<T extends object = Record<string, unknown>>(schema: Schema): T;
        /** Advance n bytes (e.g. past a foreign message) */
        skip(n: number): Reader;
        remaining(): number;
        eof(): boolean;
    }
    interface Writer {
        /** Queue a message; chainable */
        write(schema: Schema, data: object): Writer;
        /** Splice in pre-encoded bytes; chainable */
        raw(bytes: Uint8Array): Writer;
        /** Total frame size so far, without encoding */
        byteLength(): number;
        /** Emit one exactly-sized buffer */
        bytes(): Uint8Array;
    }
}
