import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';
import { playwright } from '@vitest/browser-playwright';

// Playground UI smoke tests: boot the real index.html + main.ts in an
// actual Chromium DOM (not jsdom) and drive it the way a user would —
// clicks, file uploads, drag & drop. See the root vitest.browser.config.ts
// for why @cbortech/hash-extension needs the optimizeDeps exclude that
// ./vite.config already carries (it applies here too via mergeConfig).
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: 'chromium' }],
        headless: true,
      },
      include: ['src/**/*.browser.test.ts'],
    },
  })
);
