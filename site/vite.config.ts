import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/cbor',
  },
  optimizeDeps: {
    // These packages import from @cbortech/cbor/ast. Excluding them from
    // pre-bundling ensures all code shares the same CborByteString (etc.)
    // instances, so instanceof checks inside parseTag work correctly.
    exclude: [
      '@cbortech/uuid-extension',
      '@cbortech/hash-extension',
      '@cbortech/set-map-extensions',
    ],
  },
});
