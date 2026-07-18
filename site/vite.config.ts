import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/cbor',
  },
  optimizeDeps: {
    // This package imports from @cbortech/cbor/ast. Excluding it from
    // pre-bundling ensures all code shares the same CborByteString (etc.)
    // instances, so instanceof checks inside parseTag work correctly.
    exclude: ['@cbortech/hash-extension'],
  },
});
