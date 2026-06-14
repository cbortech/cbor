import { defineConfig } from 'vitest/config';
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
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
