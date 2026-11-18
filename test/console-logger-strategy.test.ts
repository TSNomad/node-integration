/**
 * Acceptance tests for ConsoleLoggerStrategy. The logException test runs
 * the method it inherits from BaseLoggerStrategy.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { LoggerLevel } from '@tsnomad/logger';
import { ConsoleLoggerStrategy } from '@tsnomad/node-integration';
import type { ConsoleTarget } from '@tsnomad/node-integration';

type Line = { method: string; args: unknown[] };

function target(): { lines: Line[]; console: ConsoleTarget } {
  const lines: Line[] = [];
  const write = (method: string) => (...args: unknown[]) => {
    lines.push({ method, args });
  };
  return { lines, console: { error: write('error'), warn: write('warn'), info: write('info'), debug: write('debug') } };
}

const ROUTES: Record<string, string> = {
  emergency: 'error',
  alert: 'error',
  critical: 'error',
  error: 'error',
  warning: 'warn',
  notice: 'info',
  info: 'info',
  debug: 'debug',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConsoleLoggerStrategy', () => {
  test('writes each level through its console method, once, as "[level] message"', () => {
    for (const level of Object.values(LoggerLevel)) {
      const { lines, console } = target();
      new ConsoleLoggerStrategy(console)[level]('Outbox drained');
      expect(lines, level).toEqual([{ method: ROUTES[level], args: [`[${level}] Outbox drained`] }]);
    }
  });

  test('passes a context with keys as the second argument, as the same object', () => {
    for (const level of Object.values(LoggerLevel)) {
      const { lines, console } = target();
      const context = { orderId: 'o_1', attempt: 2 };
      new ConsoleLoggerStrategy(console)[level]('Sent', context);
      expect(lines, level).toHaveLength(1);
      expect(lines[0].args, level).toEqual([`[${level}] Sent`, context]);
      expect(lines[0].args[1], level).toBe(context);
    }
  });

  test('passes no second argument for an empty or missing context', () => {
    const { lines, console } = target();
    const logger = new ConsoleLoggerStrategy(console);
    logger.warning('a', {});
    logger.warning('b');

    expect(lines).toEqual([
      { method: 'warn', args: ['[warning] a'] },
      { method: 'warn', args: ['[warning] b'] },
    ]);
  });

  test("logs an exception through BaseLoggerStrategy's logException, at critical by default", () => {
    const { lines, console } = target();
    const error = new Error('disk full');
    const logger = new ConsoleLoggerStrategy(console);
    logger.logException(error, 'Saving failed', { orderId: 'o_1' });
    logger.logException(error, '', {}, 'warning');

    expect(lines).toEqual([
      { method: 'error', args: ['[critical] Saving failed - disk full', { orderId: 'o_1', exception: error }] },
      { method: 'warn', args: ['[warning] disk full', { exception: error }] },
    ]);
  });

  test("writes to Node's global console by default", () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new ConsoleLoggerStrategy();
    logger.notice('hello');
    logger.alert('help', { a: 1 });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('[notice] hello');
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[alert] help', { a: 1 });
  });
});
