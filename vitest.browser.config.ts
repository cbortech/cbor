import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';
import { playwright } from '@vitest/browser-playwright';

const browser =
  (process.env.BROWSER as 'chromium' | 'firefox' | 'webkit') ?? 'chromium';

export default mergeConfig(
  viteConfig,
  defineConfig({
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
      ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
      },
    },
  })
);
