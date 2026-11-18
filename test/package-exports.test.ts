/**
 * The public entry point, imported by package name. Runs now.
 */

import { expect, test } from 'vitest';
import * as node from '@tsnomad/node-integration';

test('exports the strategies, the Response and its factory, the initializer and the default timeout', () => {
  expect(Object.keys(node).sort()).toEqual([
    'ConsoleLoggerStrategy',
    'DEFAULT_FETCH_TIMEOUT_MS',
    'InMemoryEventStrategy',
    'InProcessTaskStrategy',
    'NativeFetchStrategy',
    'NodeInitializer',
    'NodeResponseFactory',
    'Response',
  ]);
});

test('InProcessTaskStrategy declares its logger for autowiring', async () => {
  const { LoggerStrategy } = await import('@tsnomad/logger');
  expect(node.InProcessTaskStrategy.inject).toEqual([LoggerStrategy]);
});
