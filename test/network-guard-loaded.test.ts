/**
 * The network guard in test/network-guard.ts is loaded here. These are the
 * tests that open real connections, so they must reach only loopback and
 * hosts under .invalid. 192.0.2.1 is a documentation address (RFC 5737)
 * that routes nowhere, and the guard refuses it before a socket opens.
 */

import net from 'node:net';
import { describe, expect, test } from 'vitest';

describe('the network guard in node-integration', () => {
  test('refuses a fetch to a host outside loopback and .invalid', async () => {
    await expect(fetch('http://192.0.2.1/')).rejects.toMatchObject({ name: 'NetworkGuardError' });
  });

  test('refuses a socket to a host outside loopback and .invalid', async () => {
    const error = await new Promise<unknown>((resolve) => {
      const socket = net.connect({ host: '192.0.2.1', port: 80 });
      socket.on('error', resolve);
      socket.on('connect', () => {
        socket.destroy();
        resolve(new Error('connected'));
      });
    });
    expect(error).toMatchObject({ name: 'NetworkGuardError' });
  });
});
