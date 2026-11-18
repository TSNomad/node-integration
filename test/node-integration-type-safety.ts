/**
 * Compile-only checks, run by `npm run typecheck`. Each @ts-expect-error
 * line must stay an error. Nothing here runs.
 */

import type { EventStrategy } from '@tsnomad/event';
import type { FetchStrategy } from '@tsnomad/fetch';
import type { Response as HttpResponse } from '@tsnomad/http';
import type { Initializer } from '@tsnomad/loader';
import type { LoggerStrategy } from '@tsnomad/logger';
import type { TaskStrategy } from '@tsnomad/tasks';
import {
  ConsoleLoggerStrategy,
  InMemoryEventStrategy,
  InProcessTaskStrategy,
  NativeFetchStrategy,
  NodeInitializer,
  Response,
} from '@tsnomad/node-integration';
import type { ConsoleTarget } from '@tsnomad/node-integration';

declare const logger: LoggerStrategy;

const fetchStrategy: FetchStrategy = new NativeFetchStrategy();
const withOptions: FetchStrategy = new NativeFetchStrategy({ timeout: 5_000, fetch: globalThis.fetch });
const loggerStrategy: LoggerStrategy = new ConsoleLoggerStrategy();
const taskStrategy: TaskStrategy = new InProcessTaskStrategy(logger);
const eventStrategy: EventStrategy = new InMemoryEventStrategy();
const response: HttpResponse = new Response();
const initializer: Initializer = new NodeInitializer();

// @ts-expect-error the timeout option is a number of milliseconds
new NativeFetchStrategy({ timeout: '5s' });

// @ts-expect-error the in-process strategy needs a logger
new InProcessTaskStrategy();

// @ts-expect-error a console target needs error, warn, info and debug
const partial: ConsoleTarget = { error() {}, warn() {} };

void [fetchStrategy, withOptions, loggerStrategy, taskStrategy, eventStrategy, response, initializer, partial];
