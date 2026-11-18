/**
 * NodeInitializer
 *
 * The initializer for a plain Node process, as PHPNomad's platform
 * integrations ship one. Load it first, before the application's own
 * initializers. Its class definitions bind each strategy under its
 * interface token and under its own class, so both names reach one
 * instance:
 *
 * | Concrete | Abstracts |
 * |---|---|
 * | `InMemoryEventStrategy` | `EventStrategy`, `InMemoryEventStrategy` |
 * | `ConsoleLoggerStrategy` | `LoggerStrategy`, `ConsoleLoggerStrategy` |
 * | `NativeFetchStrategy` | `FetchStrategy`, `NativeFetchStrategy` |
 * | `InProcessTaskStrategy` | `TaskStrategy`, `InProcessTaskStrategy` |
 * | `NodeResponseFactory` | `ResponseFactory`, `NodeResponseFactory` |
 *
 * The factory binding lets `RestLifecycle` autowire from the container.
 * It binds nothing for `ActionBindingStrategy` or `RestStrategy`, because
 * a plain Node process has no platform actions or routes of its own.
 */

import { EventStrategy } from '@tsnomad/event';
import { InMemoryEventStrategy } from '@tsnomad/event/in-memory-event-strategy';
import { FetchStrategy } from '@tsnomad/fetch';
import { ResponseFactory } from '@tsnomad/http';
import type { ClassDefinition, HasClassDefinitions } from '@tsnomad/loader';
import { LoggerStrategy } from '@tsnomad/logger';
import { TaskStrategy } from '@tsnomad/tasks';
import { ConsoleLoggerStrategy } from './ConsoleLoggerStrategy.js';
import { InProcessTaskStrategy } from './InProcessTaskStrategy.js';
import { NativeFetchStrategy } from './NativeFetchStrategy.js';
import { NodeResponseFactory } from './NodeResponseFactory.js';

export class NodeInitializer implements HasClassDefinitions {
  getClassDefinitions(): readonly ClassDefinition[] {
    return [
      [InMemoryEventStrategy, [EventStrategy, InMemoryEventStrategy]],
      [ConsoleLoggerStrategy, [LoggerStrategy, ConsoleLoggerStrategy]],
      [NativeFetchStrategy, [FetchStrategy, NativeFetchStrategy]],
      [InProcessTaskStrategy, [TaskStrategy, InProcessTaskStrategy]],
      [NodeResponseFactory, [ResponseFactory, NodeResponseFactory]],
    ];
  }
}
