/**
 * Unit tests for InProcessTaskStrategy, written with its implementation.
 * They cover guards the acceptance tests do not reach: a null or
 * undefined payload, a task dispatched while another runs, `whenIdle`
 * called while a task runs, and the failure context of a task with no
 * idempotency key.
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { TaskDispatchFailedException } from '@tsnomad/tasks';
import { InProcessTaskStrategy } from '@tsnomad/node-integration';
import { RecordingLogger, SendReport, SyncProducts, tick } from './fixtures.js';

let logger: RecordingLogger;
let strategy: InProcessTaskStrategy;

beforeEach(() => {
  logger = new RecordingLogger();
  strategy = new InProcessTaskStrategy(logger);
});

describe('InProcessTaskStrategy internals', () => {
  test('refuses a null or undefined payload with TaskDispatchFailedException, its cause a TypeError', async () => {
    class NullPayload extends SendReport {
      toPayload() {
        return null as never;
      }
    }
    class NoPayload extends SendReport {
      toPayload() {
        return undefined as never;
      }
    }
    let runs = 0;
    strategy.attach(SendReport, () => {
      runs++;
    });

    for (const task of [new NullPayload('n'), new NoPayload('u')]) {
      const error = await strategy.dispatch(task).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, task.constructor.name).toBeInstanceOf(TaskDispatchFailedException);
      expect((error as Error).cause, task.constructor.name).toBeInstanceOf(TypeError);
    }

    await strategy.whenIdle();
    expect(runs).toBe(0);
  });

  test('a task dispatched while another runs starts only after that one ends', async () => {
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

  test('whenIdle called while a task runs waits for that task', async () => {
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
    expect(started).toBe(true);
    expect(finished).toBe(false);

    await strategy.whenIdle();
    expect(finished).toBe(true);
  });

  test('the failure context of a task with no idempotency key holds only the task id', async () => {
    strategy.attach(SendReport, () => {
      throw new Error('send failed');
    });

    await strategy.dispatch(new SendReport('r'));
    await strategy.whenIdle();

    expect(logger.calls).toHaveLength(1);
    expect(Object.keys(logger.calls[0].args[2] as object)).toEqual(['task']);
  });
});
