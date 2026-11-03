import { createRequire } from 'node:module';

/**
 * Load Playwright via CommonJS resolution so a globally installed copy (found through NODE_PATH)
 * works as well as a local devDependency.
 */
export function loadPlaywright() {
  return createRequire(import.meta.url)('playwright');
}
