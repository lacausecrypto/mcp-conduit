/**
 * Conduit Dashboard — single-file SPA loader.
 *
 * Reads the compiled HTML at module initialization so it is ready to serve
 * on the first request with zero per-request overhead.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

/**
 * The full Conduit dashboard SPA as an HTML string.
 * Served at GET /conduit/dashboard by the admin router.
 */
export const dashboardHtml: string = readFileSync(join(__dirname, 'index.html'), 'utf-8');
