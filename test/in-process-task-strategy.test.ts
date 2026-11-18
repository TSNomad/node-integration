/**
 * Acceptance tests for InProcessTaskStrategy, which reads ids with
 * taskIdOf and rejects with TaskDispatchFailedException.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { TaskCreateFailedException, TaskDispatchFailedException } from '@tsnomad/tasks';
import type { Task } from '@tsnomad/tasks';
import { InProcessTaskStrategy } from '@tsnomad/node-integration';
import { BigIntTask, KeyedTask, RecordingLogger, SendReport, StampedTask, SyncProducts, Unbuildable, tick } from './fixtures.js';

let logger: RecordingLogger;
let strategy: InProcessTaskStrategy;

beforeEach(() => {
  logger = new RecordingLogger();
  strategy = new InProcessTaskStrategy(logger);
  SyncProducts.rebuilt = 0;
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('InProcessTaskStrategy.dispatch and attach', () => {
  test('runs the handler later, with a task rebuilt from its payload, not the dispatched instance', async () => {
    const seen: SyncProducts[] = [];
    strategy.attach(SyncProducts, (task) => {
      seen.push(task);
    });
    const original = new SyncProducts('cursor-1');

    await strategy.dispatch(original);
    expect(seen).toEqual([]);
    await strategy.whenIdle();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(SyncProducts);
    expect(seen[0]).not.toBe(original);
    expect(seen[0].cursor).toBe('cursor-1');
    expect(SyncProducts.rebuilt).toBe(1);
    expect(logger.calls).toEqual([]);
  });

  test('rebuilds the task from its payload after a JSON round trip, so the task sees only what JSON carries', async () => {
    StampedTask.received = [];
    strategy.attach(StampedTask, () => {});

    await strategy.dispatch(new StampedTask());
    await strategy.whenIdle();

    expect(StampedTask.received).toEqual([{ at: '1970-01-01T00:00:00.000Z' }]);
    expect(Object.keys(StampedTask.received[0])).toEqual(['at']);
  });

  test("runs a task's handlers one at a time, in attach order, all with the same rebuilt task", async () => {
    const log: string[] = [];
    const tasks: SyncProducts[] = [];
    for (const name of ['first', 'second', 'third']) {
      strategy.attach(SyncProducts, async (task) => {
        tasks.push(task);
        log.push(`${name} start`);
        await tick();
        log.push(`${name} end`);
      });
    }

    await strategy.dispatch(new SyncProducts('c'));
    await strategy.whenIdle();

    expect(log).toEqual(['first start', 'first end', 'second start', 'second end', 'third start', 'third end']);
    expect(tasks[0]).toBe(tasks[1]);
    expect(tasks[1]).toBe(tasks[2]);
    expect(SyncProducts.rebuilt).toBe(1);
  });

  test('starts a task dispatched by a running handler only after that task ends', async () => {
    const log: string[] = [];
    strategy.attach(SyncProducts, async () => {
      log.push('sync start');
      await strategy.dispatch(new SendReport('report'));
      await tick();
      await tick();
      log.push('sync end');
    });
    strategy.attach(SendReport, (task) => {
      log.push(task.name);
    });

    await strategy.dispatch(new SyncProducts('x'));
    await strategy.whenIdle();

    expect(log).toEqual(['sync start', 'sync end', 'report']);
  });

  test('runs queued tasks one at a time, in dispatch order', async () => {
    const log: string[] = [];
    strategy.attach(SyncProducts, async (task) => {
      log.push(`${task.cursor} start`);
      await tick();
      await tick();
      log.push(`${task.cursor} end`);
    });
    strategy.attach(SendReport, async (task) => {
      log.push(`${task.name} start`);
      await tick();
      log.push(`${task.name} end`);
    });

    await strategy.dispatch(new SyncProducts('a'));
    await strategy.dispatch(new SendReport('b'));
    await strategy.dispatch(new SyncProducts('c'));
    await strategy.whenIdle();

    expect(log).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
  });

  test('the first handler that throws ends that task, is logged once at error level, and the next task still runs', async () => {
    const boom = new Error('catalog down');
    const log: string[] = [];
    strategy.attach(SyncProducts, async (task) => {
      log.push(`one ${task.cursor}`);
      if (task.cursor === 'bad') throw boom;
    });
    strategy.attach(SyncProducts, (task) => {
      log.push(`two ${task.cursor}`);
    });

    await strategy.dispatch(new SyncProducts('bad'));
    await strategy.dispatch(new SyncProducts('good'));
    await strategy.whenIdle();

    expect(log).toEqual(['one bad', 'one good', 'two good']);
    expect(logger.calls).toEqual([
      { method: 'logException', args: [boom, "Task 'catalog.sync-products' failed", { task: 'catalog.sync-products' }, 'error'] },
    ]);
    expect(logger.calls[0].args[0]).toBe(boom);
  });

  test('logs a handler that throws synchronously the same way, and never retries it', async () => {
    let runs = 0;
    const boom = new TypeError('not a function');
    strategy.attach(SendReport, () => {
      runs++;
      throw boom;
    });

    await strategy.dispatch(new SendReport('r'));
    await strategy.whenIdle();
    await tick();
    await strategy.whenIdle();

    expect(runs).toBe(1);
    expect(logger.calls.map((c) => c.args[0])).toEqual([boom]);
  });

  test("adds the task's idempotency key to the failure context when it has one", async () => {
    const boom = new Error('export failed');
    strategy.attach(KeyedTask, () => {
      throw boom;
    });

    await strategy.dispatch(new KeyedTask('42'));
    await strategy.whenIdle();

    expect(logger.calls).toEqual([
      { method: 'logException', args: [boom, "Task 'orders.export' failed", { task: 'orders.export', idempotencyKey: 'orders.export:42' }, 'error'] },
    ]);
  });

  test('writes to console.error and goes on when the logger throws while reporting a failure', async () => {
    const boom = new Error('catalog down');
    const loggerError = new Error('log sink down');
    logger.logException = () => {
      throw loggerError;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran: string[] = [];
    strategy.attach(SyncProducts, (task) => {
      ran.push(task.cursor);
      if (task.cursor === 'bad') throw boom;
    });

    try {
      await strategy.dispatch(new SyncProducts('bad'));
      await strategy.dispatch(new SyncProducts('good'));
      await expect(strategy.whenIdle()).resolves.toBeUndefined();

      expect(ran).toEqual(['bad', 'good']);
      expect(errors.mock.calls).toEqual([
        ["Task 'catalog.sync-products' failed, and the logger threw while reporting it", { task: 'catalog.sync-products', error: boom, loggerError }],
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  test('runs a task dispatched twice twice, since it keeps no idempotency store', async () => {
    const seen: string[] = [];
    strategy.attach(KeyedTask, (task) => {
      seen.push(task.order);
    });

    await strategy.dispatch(new KeyedTask('42'));
    await strategy.dispatch(new KeyedTask('42'));
    await strategy.whenIdle();

    expect(seen).toEqual(['42', '42']);
  });

  test('runs the same handler twice when it is attached twice', async () => {
    let runs = 0;
    const handler = () => {
      runs++;
    };
    strategy.attach(SendReport, handler);
    strategy.attach(SendReport, handler);

    await strategy.dispatch(new SendReport('r'));
    await strategy.whenIdle();

    expect(runs).toBe(2);
  });

  test('rejects a task with no attached handler with TaskDispatchFailedException naming its id, and queues nothing', async () => {
    strategy.attach(SyncProducts, () => {});
    const error = await rejection(strategy.dispatch(new SendReport('r')));

    expect(error).toBeInstanceOf(TaskDispatchFailedException);
    expect((error as Error).message).toContain('reports.send');
    await strategy.whenIdle();
    expect(logger.calls).toEqual([]);
  });

  test('rejects a value that is not a task with TaskDispatchFailedException, its cause a TypeError', async () => {
    class NoId {
      toPayload() {
        return {};
      }
    }
    class IdOnly {
      static getId() {
        return 'id-only';
      }
    }
    const notTasks: unknown[] = [null, 'catalog.sync-products', {}, { toPayload: 'x' }, new NoId(), new IdOnly(), SyncProducts];
    for (const value of notTasks) {
      const error = await rejection(strategy.dispatch(value as Task));
      expect(error, String(value)).toBeInstanceOf(TaskDispatchFailedException);
      expect((error as Error).cause, String(value)).toBeInstanceOf(TypeError);
    }
  });

  test('rejects a payload that is not a plain object, or that JSON cannot carry, before any handler runs', async () => {
    let runs = 0;
    strategy.attach(BigIntTask, () => {
      runs++;
    });
    const bigint = await rejection(strategy.dispatch(new BigIntTask()));
    expect(bigint).toBeInstanceOf(TaskDispatchFailedException);
    expect((bigint as Error).message).toContain('bigint');
    expect((bigint as Error).cause).toBeInstanceOf(TypeError);

    class ListPayload extends SendReport {
      toPayload() {
        return ['not', 'an', 'object'] as never;
      }
    }
    strategy.attach(ListPayload as never, () => {
      runs++;
    });
    const list = await rejection(strategy.dispatch(new ListPayload('x')));
    expect(list).toBeInstanceOf(TaskDispatchFailedException);
    expect((list as Error).cause).toBeInstanceOf(TypeError);

    class DatePayload extends SendReport {
      toPayload() {
        return new Date(0) as never;
      }
    }
    strategy.attach(DatePayload as never, () => {
      runs++;
    });
    const date = await rejection(strategy.dispatch(new DatePayload('x')));
    expect(date).toBeInstanceOf(TaskDispatchFailedException);
    expect((date as Error).cause).toBeInstanceOf(TypeError);

    await strategy.whenIdle();
    expect(runs).toBe(0);
  });

  test("rejects when toPayload or fromPayload throws, with that error as cause, and runs nothing", async () => {
    let runs = 0;
    strategy.attach(Unbuildable, () => {
      runs++;
    });
    const unbuildable = await rejection(strategy.dispatch(new Unbuildable()));
    expect(unbuildable).toBeInstanceOf(TaskDispatchFailedException);
    expect((unbuildable as Error).cause).toBe(Unbuildable.failure);
    expect((unbuildable as Error).cause).toBeInstanceOf(TaskCreateFailedException);
    expect((unbuildable as Error).message).toContain('unbuildable');

    const thrown = new Error('cannot serialize');
    class Throws extends SendReport {
      toPayload(): never {
        throw thrown;
      }
    }
    strategy.attach(Throws as never, () => {
      runs++;
    });
    const fromToPayload = await rejection(strategy.dispatch(new Throws('x')));
    expect((fromToPayload as Error).cause).toBe(thrown);

    await strategy.whenIdle();
    expect(runs).toBe(0);
  });

  test('attach throws a TypeError for a class with no static id or a handler that is not a function', () => {
    class NoId {}
    expect(() => strategy.attach(NoId as never, () => {})).toThrow(TypeError);
    expect(() => strategy.attach(SyncProducts, 'handler' as never)).toThrow(TypeError);
    expect(() => strategy.attach(SyncProducts, undefined as never)).toThrow(TypeError);
  });
});

describe('InProcessTaskStrategy.whenIdle', () => {
  test('resolves at once when nothing is queued', async () => {
    let settled = false;
    void strategy.whenIdle().then(() => (settled = true));
    await tick();
    expect(settled).toBe(true);
  });

  test('waits for tasks that handlers dispatch while it waits', async () => {
    const log: string[] = [];
    strategy.attach(SyncProducts, async (task) => {
      log.push(`sync ${task.cursor}`);
      await strategy.dispatch(new SendReport(`after ${task.cursor}`));
    });
    strategy.attach(SendReport, async (task) => {
      await tick();
      log.push(task.name);
    });

    await strategy.dispatch(new SyncProducts('x'));
    await strategy.whenIdle();

    expect(log).toEqual(['sync x', 'after x']);
  });

  test('called while a task runs, waits for that task to finish', async () => {
    let started = false;
    let finished = false;
    strategy.attach(SyncProducts, async () => {
      started = true;
      await tick();
      await tick();
      await tick();
      finished = true;
    });

    await strategy.dispatch(new SyncProducts('x'));
    await tick();
    // The task has left the queue and is running, so only the running flag can hold whenIdle.
    expect(started).toBe(true);
    expect(finished).toBe(false);

    await strategy.whenIdle();
    expect(finished).toBe(true);
  });

  test('waits for a running task, and resolves rather than rejects after a failure', async () => {
    let finished = false;
    strategy.attach(SyncProducts, async () => {
      await tick();
      await tick();
      finished = true;
      throw new Error('late failure');
    });

    await strategy.dispatch(new SyncProducts('x'));
    await expect(strategy.whenIdle()).resolves.toBeUndefined();
    expect(finished).toBe(true);
    expect(logger.calls).toHaveLength(1);
  });
});
