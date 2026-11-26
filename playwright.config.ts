import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 30_000, fullyParallel: false, workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: process.env.OFFICE_BASE_URL || 'http://127.0.0.1:3010', channel: process.env.OFFICE_BROWSER_CHANNEL || 'chrome', headless: true,
    launchOptions: { args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  projects: [{ name: 'desktop', use: { viewport: { width: 1440, height: 960 } } }],
});
