/**
 * Path validation helpers — reject inputs that resolve into sensitive
 * system directories. Used by connect installer and managed runtime
 * sandboxes to harden against path-traversal/misconfiguration.
 */

import { resolve } from 'node:path';

const UNIX_BLOCKED_PREFIXES = [
  '/etc/', '/etc',
  '/root/', '/root',
  '/proc/', '/proc',
  '/sys/', '/sys',
  '/dev/', '/dev',
  '/boot/', '/boot',
  '/var/log/', '/var/run/',
];

const WINDOWS_BLOCKED_PREFIXES = [
  'c:\\windows\\', 'c:\\windows',
  'c:\\program files\\', 'c:\\program files',
  'c:\\program files (x86)\\',
  'c:\\programdata\\', 'c:\\programdata',
  'c:\\system volume information\\',
];

function normalize(p: string): string {
  return resolve(p).replace(/\\/g, '\\').toLowerCase();
}

/**
 * Throws if the resolved absolute path points to a known-sensitive
 * system directory. Accepts relative or absolute input.
 *
 * @param path        The candidate path (relative or absolute).
 * @param label       Human-readable description of the input (used in error messages).
 */
export function assertSafeSystemPath(path: string, label: string): string {
  const absolute = resolve(path);
  const normalized = normalize(absolute);

  const blocked = process.platform === 'win32'
    ? WINDOWS_BLOCKED_PREFIXES
    : UNIX_BLOCKED_PREFIXES;

  for (const prefix of blocked) {
    if (normalized === prefix || normalized.startsWith(prefix.endsWith('/') || prefix.endsWith('\\') ? prefix : `${prefix}/`)) {
      throw new Error(
        `${label} "${path}" resolves to a restricted system directory (${absolute}).`,
      );
    }
  }

  return absolute;
}
