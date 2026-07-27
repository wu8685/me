declare module 'bun:ffi' {
  export const FFIType: {
    i32: number;
    cstring: number;
    ptr: number;
  };

  export const read: {
    i32(pointer: number, offset?: number): number;
  };

  export function dlopen(
    library: string,
    symbols: Record<string, {
      args: number[];
      returns: number;
    }>,
  ): {
    symbols: Record<string, (...args: never[]) => unknown>;
    close(): void;
  };
}
