import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';
import { playwright } from '@vitest/browser-playwright';

const browser =
  (process.env.BROWSER as 'chromium' | 'firefox' | 'webkit') ?? 'chromium';

export default mergeConfig(
  viteConfig,
  defineConfig({
    // In browser mode `test.server.deps.inline` (the node-mode fix in
    // vite.config.ts) does not apply; instead Vite pre-bundles
    // @cbortech/hash-extension, baking the *built* dist copy of
    // `@cbortech/cbor/ast` into the optimized chunk. Excluding it from
    // pre-bundling routes its imports through the dev server resolver,
    // where the `@cbortech/cbor/ast` → src/ast alias applies, so its
    // instanceof checks see the same classes as the tests.
    optimizeDeps: {
      exclude: ['@cbortech/hash-extension'],
    },
    test: {
      globals: true,
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser }],
        headless: true,
      },
      include: ['src/**/*.test.ts'],
      exclude: [
        'src/cbor/test-vectors.test.ts',
        'src/cdn/cdn-test-vectors.test.ts',
        'src/cdn/edn-test-vectors.test.ts',
        'src/cdn/edn-abnf-vectors.test.ts',
        'src/cddl/cddl-corpus.test.ts',
        'src/cddl/cddl-validation-vectors.test.ts',
      ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
      },
    },
  })
);
