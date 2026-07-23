import { describe, expect, test } from 'vitest';
import { assertUrlAllowed, isForbiddenIp } from '../src/http/ssrf.js';
import { NodeRunError } from '../src/index.js';

describe('isForbiddenIp', () => {
  const forbidden = [
    '127.0.0.1', '127.255.255.254',          // loopback
    '10.0.0.1', '10.255.255.255',            // RFC1918 10/8
    '172.16.0.1', '172.31.255.255',          // RFC1918 172.16/12
    '192.168.0.1', '192.168.255.255',        // RFC1918 192.168/16
    '169.254.1.1',                            // link-local
    '0.0.0.0', '0.1.2.3',                     // this-network
    '::1',                                    // v6 loopback
    'fc00::1', 'fd12:3456::1',                // v6 unique local fc00::/7
    'fe80::1', 'febf::1',                     // v6 link-local fe80::/10
    '::ffff:127.0.0.1', '::ffff:10.0.0.5',    // v4-mapped
  ];
  const allowed = [
    '8.8.8.8', '1.1.1.1', '104.16.0.1',
    '172.15.255.255', '172.32.0.1',           // just outside 172.16/12
    '11.0.0.1', '192.169.0.1',
    '2606:4700::1111', '::ffff:8.8.8.8',
  ];

  test.each(forbidden)('blocks %s', (ip) => expect(isForbiddenIp(ip)).toBe(true));
  test.each(allowed)('allows %s', (ip) => expect(isForbiddenIp(ip)).toBe(false));
});

describe('assertUrlAllowed', () => {
  const resolvePublic = async () => ['93.184.216.34'];
  const resolvePrivate = async () => ['10.0.0.5'];
  const resolveMixed = async () => ['93.184.216.34', '127.0.0.1'];

  test('allows public https url', async () => {
    await expect(assertUrlAllowed('https://example.com/x', { resolve: resolvePublic })).resolves.toBeUndefined();
  });

  test('rejects non-http(s) schemes', async () => {
    for (const url of ['ftp://example.com', 'file:///etc/passwd', 'gopher://x']) {
      const err = await assertUrlAllowed(url, { resolve: resolvePublic }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NodeRunError);
      expect((err as NodeRunError).code).toBe('ssrf_blocked');
    }
  });

  test('rejects malformed urls', async () => {
    const err = await assertUrlAllowed('not a url', { resolve: resolvePublic }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).code).toBe('invalid_url');
  });

  test('rejects literal forbidden IPs and hostnames resolving to them', async () => {
    for (const url of ['http://127.0.0.1:3000/x', 'http://[::1]/x', 'http://10.1.2.3/']) {
      const err = await assertUrlAllowed(url, { resolve: resolvePublic }).catch((e: unknown) => e);
      expect((err as NodeRunError).code).toBe('ssrf_blocked');
    }
    const err = await assertUrlAllowed('http://internal.corp/x', { resolve: resolvePrivate }).catch(
      (e: unknown) => e,
    );
    expect((err as NodeRunError).code).toBe('ssrf_blocked');
  });

  test('rejects if ANY resolved address is forbidden', async () => {
    const err = await assertUrlAllowed('http://evil.example/x', { resolve: resolveMixed }).catch(
      (e: unknown) => e,
    );
    expect((err as NodeRunError).code).toBe('ssrf_blocked');
  });

  test('allowPrivate bypasses IP checks but not scheme checks', async () => {
    await expect(
      assertUrlAllowed('http://127.0.0.1:9999/stub', { allowPrivate: true, resolve: resolvePrivate }),
    ).resolves.toBeUndefined();
    const err = await assertUrlAllowed('file:///x', { allowPrivate: true }).catch((e: unknown) => e);
    expect((err as NodeRunError).code).toBe('ssrf_blocked');
  });

  test('SSRF errors are never retryable', async () => {
    const err = await assertUrlAllowed('http://10.0.0.1/', { resolve: resolvePublic }).catch((e: unknown) => e);
    expect((err as NodeRunError).retryable).toBe(false);
  });
});
