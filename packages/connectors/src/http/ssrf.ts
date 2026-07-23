import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { NodeRunError } from '../types.js';

export interface SsrfOptions {
  allowPrivate?: boolean;
  resolve?: (hostname: string) => Promise<string[]>;
}

function forbiddenV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const [a, b] = [parts[0]!, parts[1]!];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // this-network
  return false;
}

export function isForbiddenIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return forbiddenV4(ip);
  if (kind === 6) {
    const norm = ip.toLowerCase();
    if (norm === '::1') return true; // loopback
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(norm);
    if (mapped) return forbiddenV4(mapped[1]!); // v4-mapped
    const firstGroup = norm.split(':').find((g) => g.length > 0) ?? '';
    const value = parseInt(firstGroup.padEnd(4, '0'), 16);
    if ((value & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((value & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  return false;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

export async function assertUrlAllowed(rawUrl: string, opts: SsrfOptions = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NodeRunError('invalid_url', `Invalid URL: ${rawUrl}`, false);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NodeRunError('ssrf_blocked', `Scheme '${url.protocol}' is not allowed`, false);
  }
  if (opts.allowPrivate) return;

  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const addresses = isIP(hostname) ? [hostname] : await (opts.resolve ?? defaultResolve)(hostname);
  for (const ip of addresses) {
    if (isForbiddenIp(ip)) {
      throw new NodeRunError(
        'ssrf_blocked',
        `Host '${url.hostname}' resolves to a private or loopback address, which is blocked by default`,
        false,
      );
    }
  }
}
