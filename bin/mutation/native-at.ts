/// <reference path="./bun-ffi.d.ts" />

import * as os from 'os';
import { dlopen, FFIType, read } from 'bun:ffi';
import type { MutationAtomicOperations } from './contracts';

interface NativeLibrary {
  handle: { close(): void };
  symbols: {
    openat(
      parentDescriptor: number,
      name: Buffer,
      flags: number,
      mode: number,
    ): number;
    linkat(
      sourceParentDescriptor: number,
      sourceName: Buffer,
      destinationParentDescriptor: number,
      destinationName: Buffer,
      flags: number,
    ): number;
    renameat(
      sourceParentDescriptor: number,
      sourceName: Buffer,
      destinationParentDescriptor: number,
      destinationName: Buffer,
    ): number;
    unlinkat(parentDescriptor: number, name: Buffer, flags: number): number;
    mkdirat(parentDescriptor: number, name: Buffer, mode: number): number;
    errnoLocation(): number;
  };
}

const AT_REMOVEDIR = 0x0080;
let library: NativeLibrary | undefined;

function unsupported(): never {
  const error = new Error(
    'descriptor-relative filesystem primitives unavailable',
  ) as NodeJS.ErrnoException;
  error.code = 'ENOTSUP';
  throw error;
}

function loadLibrary(): NativeLibrary {
  if (library) return library;
  const libraryPath = process.platform === 'darwin'
    ? '/usr/lib/libSystem.B.dylib'
    : process.platform === 'linux'
      ? 'libc.so.6'
      : undefined;
  if (!libraryPath) unsupported();
  const errnoSymbol = process.platform === 'darwin' ? '__error' : '__errno_location';
  try {
    const loaded = dlopen(libraryPath, {
      openat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      linkat: {
        args: [
          FFIType.i32,
          FFIType.cstring,
          FFIType.i32,
          FFIType.cstring,
          FFIType.i32,
        ],
        returns: FFIType.i32,
      },
      renameat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring],
        returns: FFIType.i32,
      },
      unlinkat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32],
        returns: FFIType.i32,
      },
      mkdirat: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32],
        returns: FFIType.i32,
      },
      [errnoSymbol]: { args: [], returns: FFIType.ptr },
    });
    const symbols = loaded.symbols as unknown as NativeLibrary['symbols'] & {
      __error?: () => number;
      __errno_location?: () => number;
    };
    symbols.errnoLocation = process.platform === 'darwin'
      ? symbols.__error!
      : symbols.__errno_location!;
    library = { handle: loaded, symbols };
    return library;
  } catch {
    unsupported();
  }
}

function cString(name: string): Buffer {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    const error = new Error('unsafe descriptor-relative name') as NodeJS.ErrnoException;
    error.code = 'EINVAL';
    throw error;
  }
  return Buffer.from(`${name}\0`);
}

function nativeFailure(syscall: string): never {
  const loaded = loadLibrary();
  const numeric = read.i32(loaded.symbols.errnoLocation(), 0);
  const code = Object.entries(os.constants.errno)
    .find(([, value]) => value === numeric)?.[0] ?? 'EIO';
  const error = new Error(`${syscall} failed: ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  error.errno = numeric;
  error.syscall = syscall;
  throw error;
}

export function createNativeMutationAtomicOperations(): MutationAtomicOperations {
  return {
    openAt(parentDescriptor, name, flags, mode = 0) {
      const result = loadLibrary().symbols.openat(
        parentDescriptor,
        cString(name),
        flags,
        mode,
      );
      if (result < 0) nativeFailure('openat');
      return result;
    },
    linkAt(sourceParentDescriptor, sourceName, destinationParentDescriptor, destinationName) {
      const result = loadLibrary().symbols.linkat(
        sourceParentDescriptor,
        cString(sourceName),
        destinationParentDescriptor,
        cString(destinationName),
        0,
      );
      if (result < 0) nativeFailure('linkat');
    },
    renameAt(sourceParentDescriptor, sourceName, destinationParentDescriptor, destinationName) {
      const result = loadLibrary().symbols.renameat(
        sourceParentDescriptor,
        cString(sourceName),
        destinationParentDescriptor,
        cString(destinationName),
      );
      if (result < 0) nativeFailure('renameat');
    },
    unlinkAt(parentDescriptor, name, directory) {
      const result = loadLibrary().symbols.unlinkat(
        parentDescriptor,
        cString(name),
        directory ? AT_REMOVEDIR : 0,
      );
      if (result < 0) nativeFailure('unlinkat');
    },
    mkdirAt(parentDescriptor, name, mode) {
      const result = loadLibrary().symbols.mkdirat(
        parentDescriptor,
        cString(name),
        mode,
      );
      if (result < 0) nativeFailure('mkdirat');
    },
  };
}
