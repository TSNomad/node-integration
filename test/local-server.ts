/**
 * A loopback HTTP server for the fetch tests. It listens on 127.0.0.1 on a
 * free port and records every request it receives.
 *
 * Routes:
 * - `/echo...` answers 200 with JSON `{ method, url, headers, body }` and
 *   the header `X-Reply: yes`.
 * - `/status/<code>` answers that status with the body `status <code>`.
 * - `/redirect` answers 302 with `Location: /target`.
 * - `/slow-headers` answers after 2 seconds.
 * - `/slow-body` sends its headers and part of a body, then stalls.
 * - `/drop-body` promises 100 bytes, sends 10, then destroys the socket.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface LocalServer {
  readonly origin: string;
  readonly received: Received[];
  close(): Promise<void>;
}

function route(req: IncomingMessage, body: string, res: ServerResponse): void {
  const url = req.url ?? '/';
  const path = url.split('?')[0];
  if (path === '/echo') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Reply': 'yes' });
    res.end(JSON.stringify({ method: req.method, url, headers: req.headers, body }));
    return;
  }
  const status = /^\/status\/(\d{3})$/.exec(path);
  if (status) {
    res.writeHead(Number(status[1]), { 'Content-Type': 'text/plain' });
    res.end(`status ${status[1]}`);
    return;
  }
  if (path === '/redirect') {
    res.writeHead(302, { Location: '/target' });
    res.end();
    return;
  }
  if (path === '/slow-headers') {
    setTimeout(() => {
      if (!res.destroyed) res.end('late');
    }, 2000).unref();
    return;
  }
  if (path === '/slow-body') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('partial');
    return;
  }
  if (path === '/drop-body') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '100' });
    res.write('0123456789', () => setTimeout(() => res.socket?.destroy(), 20));
    return;
  }
  res.writeHead(404);
  res.end('no route');
}

export async function startLocalServer(): Promise<LocalServer> {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      route(req, body, res);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A loopback port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
