// Shared launch settings for functional checks and optional hardware measurements.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../build-web-tools/browser-test/package.json', import.meta.url));
const { chromium } = require('playwright');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const softwareRendering = process.env.BROWSER_GPU !== 'hardware';

export function launchBrowser() {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync(chrome) ? chrome : undefined),
    headless: process.env.BROWSER_HEADLESS !== '0',
    args: softwareRendering
      ? ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--enable-webgl'],
  });
}
