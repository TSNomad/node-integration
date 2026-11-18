/**
 * Acceptance tests for NodeInitializer, in the integration shape: a real
 * container, the real loader, and the real strategies, with only the
 * network replaced by a loopback server. They also run RestLifecycle from
 * @tsnomad/rest, autowired from the booted container.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { Container } from '@tsnomad/di-container';
import { EventStrategy } from '@tsnomad/event';
import type { Event } from '@tsnomad/event';
import { FetchPayload, FetchStrategy } from '@tsnomad/fetch';
import { Method, ResponseFactory } from '@tsnomad/http';
import type { Request } from '@tsnomad/http';
import { Bootstrapper } from '@tsnomad/loader';
import { LoggerStrategy } from '@tsnomad/logger';
import { RestException, RestLifecycle } from '@tsnomad/rest';
import type { Controller } from '@tsnomad/rest';
import { TaskStrategy } from '@tsnomad/tasks';
import type { CanHandleTask } from '@tsnomad/tasks';
import {
  ConsoleLoggerStrategy,
  InMemoryEventStrategy,
  InProcessTaskStrategy,
  NativeFetchStrategy,
  NodeInitializer,
  NodeResponseFactory,
  Response,
} from '@tsnomad/node-integration';
import { SyncProducts } from './fixtures.js';
import { startLocalServer } from './local-server.js';
import type { LocalServer } from './local-server.js';

let server: LocalServer;

beforeAll(async () => {
  server = await startLocalServer();
});

afterAll(async () => {
  await server.close();
});

let consoleError: MockInstance;
let consoleWarn: MockInstance;

beforeEach(() => {
  // Tripwires: the strategies report a lost failure on console.error, and
  // ConsoleLoggerStrategy writes warning and above to console.warn and
  // console.error. No test here expects either.
  consoleError = vi.spyOn(console, 'error');
  consoleWarn = vi.spyOn(console, 'warn');
});

afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled();
  expect(consoleWarn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  seen.length = 0;
  server.received.length = 0;
});

class ProductsSynced implements Event {
  static getId(): string {
    return 'catalog.products-synced';
  }
  constructor(readonly cursor: string) {}
}

const seen: string[] = [];

/** A task handler the loader resolves from the container, with the logger and events injected. */
class SyncProductsHandler implements CanHandleTask<SyncProducts> {
  static readonly inject = [LoggerStrategy, EventStrategy] as const;
  constructor(
    private readonly logger: LoggerStrategy,
    private readonly events: EventStrategy,
  ) {}
  async handle(task: SyncProducts): Promise<void> {
    this.logger.info('Syncing products', { cursor: task.cursor });
    await this.events.broadcast(new ProductsSynced(task.cursor));
  }
}

class RecordSync {
  handle(event: ProductsSynced): void {
    seen.push(`synced ${event.cursor}`);
  }
}

class AppInitializer {
  getListeners() {
    return { [ProductsSynced.getId()]: RecordSync };
  }
  getTaskHandlers() {
    return [[SyncProducts, SyncProductsHandler]] as const;
  }
}

async function boot(): Promise<Container> {
  const container = new Container();
  await new Bootstrapper(container, new NodeInitializer(), new AppInitializer()).load();
  return container;
}

describe('NodeInitializer', () => {
  test('binds each strategy under its interface token and its own class', () => {
    expect(new NodeInitializer().getClassDefinitions()).toEqual([
      [InMemoryEventStrategy, [EventStrategy, InMemoryEventStrategy]],
      [ConsoleLoggerStrategy, [LoggerStrategy, ConsoleLoggerStrategy]],
      [NativeFetchStrategy, [FetchStrategy, NativeFetchStrategy]],
      [InProcessTaskStrategy, [TaskStrategy, InProcessTaskStrategy]],
      [NodeResponseFactory, [ResponseFactory, NodeResponseFactory]],
    ]);
  });

  test('loaded through the real loader, each token and its class reach one instance', async () => {
    const container = await boot();

    expect(await container.get(EventStrategy)).toBe(await container.get(InMemoryEventStrategy));
    expect(await container.get(LoggerStrategy)).toBe(await container.get(ConsoleLoggerStrategy));
    expect(await container.get(FetchStrategy)).toBe(await container.get(NativeFetchStrategy));
    expect(await container.get(TaskStrategy)).toBe(await container.get(InProcessTaskStrategy));
    expect(await container.get(ResponseFactory)).toBe(await container.get(NodeResponseFactory));
    expect(await container.get(EventStrategy)).toBeInstanceOf(InMemoryEventStrategy);
  });

  test("a task handler from an initializer runs on the in-process strategy the loader found by its 'TaskStrategy' name", async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const container = await boot();
    const tasks = await container.get(InProcessTaskStrategy);

    await (await container.get(TaskStrategy)).dispatch(new SyncProducts('cursor-9'));
    await tasks.whenIdle();

    expect(seen).toEqual(['synced cursor-9']);
    expect(info).toHaveBeenCalledWith('[info] Syncing products', { cursor: 'cursor-9' });
  });

  test('the bound FetchStrategy reaches a loopback server', async () => {
    const container = await boot();
    const fetchStrategy = await container.get(FetchStrategy);

    const response = await fetchStrategy.fetch(new FetchPayload(`${server.origin}/status/204`, null));

    expect(response.getStatus()).toBe(204);
    expect(server.received.map((r) => r.url)).toContain('/status/204');
  });

  test("RestLifecycle autowires from the booted container and answers an error through the bound factory's Response", async () => {
    const container = await boot();
    const runner = await container.get(RestLifecycle);
    const controller: Controller = {
      getEndpoint: () => '/orders/{id}',
      getMethod: () => Method.Get,
      getResponse: async () => {
        throw new RestException('Order not found', { id: '7' }, 404);
      },
    };

    const request: Request = {
      getHeader: () => null,
      setHeader: () => {},
      getHeaders: () => ({}),
      getParam: () => null,
      hasParam: () => false,
      setParam: () => {},
      removeParam: () => {},
      getBody: () => '',
      getParams: () => ({}),
    };
    const response = await runner.handle(controller, request);

    expect(response).toBeInstanceOf(Response);
    expect(response.getStatus()).toBe(404);
    expect(response.getJson()).toEqual({ error: { message: 'Order not found', context: { id: '7' } } });
  });
});
