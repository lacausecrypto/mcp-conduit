/**
 * Backend de discovery DNS SRV.
 *
 * Interroge des enregistrements DNS SRV pour découvrir
 * automatiquement les serveurs MCP dans un réseau.
 * Format typique : _mcp._tcp.internal.example.com
 */

import { resolveSrv } from 'node:dns/promises';
import type { DiscoveryBackend, DiscoveredServer } from './types.js';

export class DnsDiscoveryBackend implements DiscoveryBackend {
  readonly name = 'dns-srv';
  private readonly domain: string;

  constructor(domain: string) {
    this.domain = domain;
  }

  async poll(): Promise<DiscoveredServer[]> {
    try {
      const records = await resolveSrv(this.domain);
      return records.map(srvToServer);
    } catch (error) {
      // DNS lookup failure — log and return empty
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[Conduit/Discovery] DNS SRV lookup failed for "${this.domain}": ${msg}`);
      return [];
    }
  }
}

function srvToServer(record: { name: string; port: number }): DiscoveredServer {
  // SRV records provide host + port
  const host = record.name;
  const port = record.port;
  const id = `dns-${host}-${port}`;
  const url = `http://${host}:${port}/mcp`;

  return { id, url, transport: 'http' };
}
