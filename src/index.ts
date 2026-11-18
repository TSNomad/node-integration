/**
 * @tsnomad/node-integration
 *
 * Public entry point. Strategies that need only Node itself, the
 * in-memory `Response` and its factory, and the initializer that binds
 * them.
 */

export { Response } from './Response.js';
export type { ResponseSnapshot } from './Response.js';
export { NodeResponseFactory } from './NodeResponseFactory.js';
export { NativeFetchStrategy, DEFAULT_FETCH_TIMEOUT_MS } from './NativeFetchStrategy.js';
export type { NativeFetchOptions } from './NativeFetchStrategy.js';
export { ConsoleLoggerStrategy } from './ConsoleLoggerStrategy.js';
export type { ConsoleTarget } from './ConsoleLoggerStrategy.js';
export { InProcessTaskStrategy } from './InProcessTaskStrategy.js';
export { NodeInitializer } from './NodeInitializer.js';

/**
 * The in-memory `EventStrategy`. This is the class @tsnomad/event ships,
 * from its `./in-memory-event-strategy` subpath, so either import gives
 * one class and one bus. Its source moves here at the event package's
 * next major release.
 */
export { InMemoryEventStrategy } from '@tsnomad/event/in-memory-event-strategy';
