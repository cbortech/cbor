import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig({
  resolve: {
    extensions: ['.ts', '.js'],
  },
  plugins: [
    dts({
      include: ['src/**/*'],
      exclude: ['src/**/*.test.ts'],
      outDir: 'dist',
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'ast/index': resolve(__dirname, 'src/ast/index.ts'),
        'cdn/index': resolve(__dirname, 'src/cdn/index.ts'),
        'cddl/index': resolve(__dirname, 'src/cddl/index.ts'),
      },
      name: 'CBOR',
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => {
        if (format === 'es') return `${entryName}.js`;
        if (format === 'cjs') return `${entryName}.cjs`;
        return `${entryName}.${format}.js`;
      },
    },
    rollupOptions: {
      external: [],
      output: {
        exports: 'named',
      },
    },
    sourcemap: true,
    outDir: 'dist',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'site/src/**/*.test.ts'],
    // Playground UI smoke tests run against a real browser DOM (see
    // site/vitest.browser.config.ts) — they crash immediately under this
    // Node environment, so exclude them here the same way the other
    // special-runner test files below are excluded.
    exclude: [...configDefaults.exclude, 'site/src/playground.browser.test.ts'],
    // @cbortech/hash-extension (used by site/src/samples.test.ts) does its
    // own `instanceof CborByteString` checks against the classes exported
    // from `@cbortech/cbor/ast`. Left unaliased, that resolves to the
    // *built* dist (via the node_modules self-symlink), a different class
    // instance than the one our own test code gets from local `src/ast` —
    // so the checks fail even though the data is valid. Alias just this
    // one entrypoint to source so both sides share the same classes.
    alias: {
      '@cbortech/cbor/ast': resolve(__dirname, 'src/ast/index.ts'),
    },
    // Vitest externalizes node_modules deps to Node's own resolver by
    // default, bypassing the alias above. Inlining this one dependency
    // routes it through Vite's resolver instead, so the alias applies.
    server: {
      deps: {
        inline: ['@cbortech/hash-extension'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
