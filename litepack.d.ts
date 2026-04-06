type FieldType =
    | 'uint8' | 'int8' | 'uint16' | 'int16' | 'uint32' | 'int32' | 'uint64'
    | 'float32' | 'float64' | 'bool' | 'varint'
    | 'string' | 'bytes' | 'tail';

type FieldDef =
    | [string, FieldType | `${FieldType}?`]
    | [string, 'bits', [string, number][]]
    | [string, 'enum' | `enum?`, string[]]
    | [string, 'set' | `set?`, string[]]
    | [string, 'fixed', number]
    | [string, 'struct', FieldDef[]]
    | [string, 'array' | `array?`, string, ...any[]]
    | [string, string, Record<string, FieldDef[]>];

type Schema = FieldDef[];

interface Codec {
    encode(value: any): Uint8Array;
    decode(buf: Uint8Array): any;
}

interface Litepack {
    encode(schema: Schema, data: Record<string, any>): Uint8Array;
    decode(schema: Schema, buf: Uint8Array | ArrayBuffer): Record<string, any>;
    codec(name: string, codec: Codec): void;
    version: string;
}

declare const litepack: Litepack;
export default litepack;
export declare var encode: Litepack['encode'];
export declare var decode: Litepack['decode'];
export declare var codec: Litepack['codec'];
