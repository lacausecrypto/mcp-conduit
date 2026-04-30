/**
 * Conduit Dashboard — single-file SPA loader.
 *
 * Reads the compiled HTML at module initialization so it is ready to serve
 * on the first request with zero per-request overhead.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

function compileDashboardHtml(html: string): string {
  return html.replace(
    /<script\s+type="text\/(?:conduit-dashboard|babel)"[^>]*>([\s\S]*?)<\/script>/g,
    (_match, source: string) => {
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          jsx: ts.JsxEmit.React,
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText.trim();

      return `<script>\n${compiled}\n</script>`;
    },
  );
}

/**
 * The full Conduit dashboard SPA as an HTML string.
 * Served at GET /conduit/dashboard by the admin router.
 */
export const dashboardHtml: string = compileDashboardHtml(
  readFileSync(join(__dirname, 'index.html'), 'utf-8'),
);

function buildInlineScriptHashes(html: string): string[] {
  const matches = html.matchAll(/<script(?![^>]+\bsrc=)[^>]*>([\s\S]*?)<\/script>/g);
  const hashes: string[] = [];

  for (const match of matches) {
    const content = match[1];
    if (!content) continue;
    const hash = createHash('sha256').update(content).digest('base64');
    hashes.push(`'sha256-${hash}'`);
  }

  return hashes;
}

const inlineScriptHashes = buildInlineScriptHashes(dashboardHtml);

export const dashboardCsp: string = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' https://fonts.bunny.net",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  `script-src 'self' https://unpkg.com ${inlineScriptHashes.join(' ')}`.trim(),
  "style-src 'self' 'unsafe-inline' https://fonts.bunny.net",
].join('; ');
