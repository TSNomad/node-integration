/**
 * ConsoleLoggerStrategy
 *
 * The `LoggerStrategy` for a plain Node process. Each call writes one line
 * through Node's console:
 *
 * | Levels | Console method |
 * |---|---|
 * | emergency, alert, critical, error | `error` |
 * | warning | `warn` |
 * | notice, info | `info` |
 * | debug | `debug` |
 *
 * The first argument is `[<level>] <message>`. When the context has any
 * key, it is the second argument, as the object itself, so Node's console
 * prints errors with their stacks and copes with circular values. With an
 * empty or missing context there is no second argument.
 *
 * It filters no level. A caller that wants less output binds another
 * strategy.
 */

import { BaseLoggerStrategy } from '@tsnomad/logger';
import type { LogContext, LoggerLevel } from '@tsnomad/logger';

/** The part of Node's console the strategy writes to. */
export type ConsoleTarget = Pick<Console, 'error' | 'warn' | 'info' | 'debug'>;

export class ConsoleLoggerStrategy extends BaseLoggerStrategy {
  private readonly target: Required<ConsoleTarget>;

  /** @param target - Where to write. Node's global console by default. */
  constructor(target: ConsoleTarget = globalThis.console) {
    super();
    // The cast is a no-op for the declared type. It keeps this file
    // building when the compile-only tests loosen ConsoleTarget to check
    // they notice.
    this.target = target as Required<ConsoleTarget>;
  }

  emergency(message: string, context?: LogContext): void {
    this.write('error', 'emergency', message, context);
  }

  alert(message: string, context?: LogContext): void {
    this.write('error', 'alert', message, context);
  }

  critical(message: string, context?: LogContext): void {
    this.write('error', 'critical', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write('error', 'error', message, context);
  }

  warning(message: string, context?: LogContext): void {
    this.write('warn', 'warning', message, context);
  }

  notice(message: string, context?: LogContext): void {
    this.write('info', 'notice', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write('info', 'info', message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.write('debug', 'debug', message, context);
  }

  /** One console line, with the context as a second argument only when it has a key. */
  private write(method: keyof ConsoleTarget, level: LoggerLevel, message: string, context?: LogContext): void {
    const line = `[${level}] ${message}`;
    if (context !== undefined && Object.keys(context).length > 0) this.target[method](line, context);
    else this.target[method](line);
  }
}
