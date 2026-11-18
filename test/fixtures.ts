/**
 * Task classes and a recording logger the node-integration tests share.
 */

import { TaskCreateFailedException } from '@tsnomad/tasks';
import type { Task, TaskPayload } from '@tsnomad/tasks';
import type { LogContext, LoggerLevel, LoggerStrategy } from '@tsnomad/logger';

export class SyncProducts implements Task {
  static rebuilt = 0;
  static getId(): string {
    return 'catalog.sync-products';
  }
  static fromPayload(payload: TaskPayload): SyncProducts {
    if (typeof payload.cursor !== 'string') throw new TaskCreateFailedException('cursor must be a string');
    SyncProducts.rebuilt++;
    return new SyncProducts(payload.cursor);
  }
  constructor(readonly cursor: string) {}
  toPayload(): TaskPayload {
    return { cursor: this.cursor };
  }
}

export class SendReport implements Task {
  static getId(): string {
    return 'reports.send';
  }
  static fromPayload(payload: TaskPayload): SendReport {
    return new SendReport(String(payload.name));
  }
  constructor(readonly name: string) {}
  toPayload(): TaskPayload {
    return { name: this.name };
  }
}

/** A task that names its logical work with an idempotency key. */
export class KeyedTask implements Task {
  static getId(): string {
    return 'orders.export';
  }
  static fromPayload(payload: TaskPayload): KeyedTask {
    return new KeyedTask(String(payload.order));
  }
  constructor(readonly order: string) {}
  toPayload(): TaskPayload {
    return { order: this.order };
  }
  idempotencyKey(): string {
    return `orders.export:${this.order}`;
  }
  idempotencyTtlSeconds(): number {
    return 60;
  }
}

/** A task whose payload JSON changes: a Date becomes a string and an undefined key goes. */
export class StampedTask implements Task {
  static received: TaskPayload[] = [];
  static getId(): string {
    return 'audit.stamp';
  }
  static fromPayload(payload: TaskPayload): StampedTask {
    StampedTask.received.push(payload);
    return new StampedTask();
  }
  toPayload(): TaskPayload {
    return { at: new Date(0), note: undefined };
  }
}

/** A task whose payload holds a value JSON cannot carry. */
export class BigIntTask implements Task {
  static getId(): string {
    return 'bigint';
  }
  static fromPayload(): BigIntTask {
    return new BigIntTask();
  }
  toPayload(): TaskPayload {
    return { amount: 10n };
  }
}

/** A task whose class refuses every payload. */
export class Unbuildable implements Task {
  static readonly failure = new TaskCreateFailedException('never buildable');
  static getId(): string {
    return 'unbuildable';
  }
  static fromPayload(): Unbuildable {
    throw Unbuildable.failure;
  }
  toPayload(): TaskPayload {
    return {};
  }
}

export type LogCall = { method: string; args: unknown[] };

export class RecordingLogger implements LoggerStrategy {
  readonly calls: LogCall[] = [];
  private record(method: string, args: unknown[]) { this.calls.push({ method, args }); }
  emergency(message: string, context?: LogContext) { this.record('emergency', [message, context]); }
  alert(message: string, context?: LogContext) { this.record('alert', [message, context]); }
  critical(message: string, context?: LogContext) { this.record('critical', [message, context]); }
  error(message: string, context?: LogContext) { this.record('error', [message, context]); }
  warning(message: string, context?: LogContext) { this.record('warning', [message, context]); }
  notice(message: string, context?: LogContext) { this.record('notice', [message, context]); }
  info(message: string, context?: LogContext) { this.record('info', [message, context]); }
  debug(message: string, context?: LogContext) { this.record('debug', [message, context]); }
  logException(error: unknown, message?: string, context?: LogContext, level?: LoggerLevel) {
    this.record('logException', [error, message, context, level]);
  }
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
