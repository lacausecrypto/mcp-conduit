import { chmodSync, existsSync } from 'node:fs';

/**
 * Restricts a SQLite file and its WAL/SHM companions to 0o600 so logs and
 * identity/governance secrets stored at rest are not world-readable when the
 * host umask is permissive. No-op on Windows (chmodSync is tolerated but
 * meaningless; ACLs should be set at deploy time).
 */
export function hardenSqliteFilePermissions(dbPath: string): void {
  if (process.platform === 'win32') return;
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) {
      try { chmodSync(file, 0o600); } catch { /* best effort */ }
    }
  }
}
