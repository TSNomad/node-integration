/**
 * InProcessTaskStrategy
 *
 * The `TaskStrategy` for a plain Node process: it runs each task in the
 * same process, soon after dispatch, one task at a time. Nothing survives
 * a restart, and a failed task is logged and dropped, with no retry and
 * no record kept. So use it only where a lost task costs nothing, such as
 * tests or a reference platform. Work that must reach another system
 * needs a durable `TaskStrategy`, which owns retries, dead letters and any
 * hook that settles a task's state after its last failure.
 *
 * `dispatch(task)` does all its checks before it resolves, so a task that
 * no durable queue could carry fails where it was dispatched:
 *
 * 1. The task must be an object whose class has a static id, read with
 *    `taskIdOf`, and a `toPayload` method.
 * 2. At least one handler must be attached for that id. In one process the
 *    handlers are all known, so a task nothing would run is a wiring
 *    mistake.
 * 3. The payload must be a plain object, one whose prototype is
 *    `Object.prototype`, so an array, a `Date` or a class instance is
 *    refused. It goes through `JSON.stringify` and `JSON.parse`, and the
 *    class's `fromPayload` rebuilds the task from the result, so the task
 *    sees only what JSON carries. The handlers
 *    receive that rebuilt task, never the instance that was dispatched,
 *    as a queue would hand them.
 *
 * Any failed check rejects with `TaskDispatchFailedException` naming the
 * task id where there is one, with the underlying error as `cause`, and
 * queues nothing. For a value that is not a task, or a payload that is not
 * a plain object, the cause is a TypeError. For a payload JSON cannot
 * carry, it is the error `JSON.stringify` threw, and for a failing
 * `toPayload` or `fromPayload`, the error that method threw. Otherwise the
 * task joins the queue and `dispatch` resolves before any handler runs.
 *
 * Queued tasks run one at a time, in dispatch order, each on a later turn
 * of the event loop. A task's handlers run one at a time, in attach order,
 * each awaited, all with the same rebuilt task. The first handler that
 * throws ends that task's run, so later handlers do not run, and the
 * failure is logged once through `LoggerStrategy.logException(error,
 * "Task '<id>' failed", context, 'error')`. The context is
 * `{ task: <id> }`, plus `idempotencyKey` with the task's key when the
 * rebuilt task implements `IsIdempotent`, so two failed runs of one class
 * can be told apart. The next task still runs. The strategy never retries
 * a run. A task dispatched twice runs twice.
 *
 * When the logger itself throws while it reports a failure, the strategy
 * writes one line through Node's `console.error`, `console.error("Task
 * '<id>' failed, and the logger threw while reporting it", { task: <id>,
 * error, loggerError })`, and goes on with the next task, so the queue
 * never stalls and neither error is lost.
 *
 * Where this differs from PHPNomad: PHPNomad has no in-process strategy.
 * The rules follow its Redis worker, which rebuilds each task from its
 * payload, runs the handlers in order, stops at the first failure, and
 * logs it. This strategy has no `IdempotencyStore`, so a task dispatched
 * twice runs twice. `whenIdle()` is its own addition.
 */

import { LoggerStrategy } from '@tsnomad/logger';
import type { LogContext } from '@tsnomad/logger';
import { TaskDispatchFailedException, taskIdOf } from '@tsnomad/tasks';
import type { Task, TaskClass, TaskStrategy } from '@tsnomad/tasks';

type Handler = (task: Task) => void | Promise<void>;

/*
 * The strategy calls `toPayload`, `fromPayload` and `logException`
 * through these local shapes, so it still compiles when an interface marks
 * one of them optional. Dispatch checks `toPayload` before the call, and
 * a missing `fromPayload` or logger fails inside the matching try.
 */
type Serializable = { toPayload(): unknown };
type Rebuildable = { fromPayload(payload: Record<string, unknown>): Task };
type ExceptionLogger = Pick<LoggerStrategy, 'logException'>;

/** A task that passed every dispatch check, rebuilt from its payload. */
type QueuedTask = { readonly id: string; readonly task: Task };

export class InProcessTaskStrategy implements TaskStrategy {
  static readonly inject = [LoggerStrategy] as const;

  /** Handlers by task id, in attach order. */
  private readonly handlers = new Map<string, Handler[]>();

  /** Tasks waiting to run, in dispatch order. */
  private readonly queue: QueuedTask[] = [];

  /** True while a task's handlers run. */
  private running = false;

  /** True while a turn that starts the next task is scheduled. */
  private scheduled = false;

  /** Callers of `whenIdle` waiting for the queue to empty. */
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly logger: LoggerStrategy) {}

  /**
   * Adds a handler for the class's id, after any already attached. The
   * same handler attached twice runs twice.
   *
   * @throws TypeError when the class has no usable static id, see
   *   `taskIdOf`, or the handler is not a function
   */
  attach<T extends Task>(taskClass: TaskClass<T>, handler: (task: T) => void | Promise<void>): void {
    const id = taskIdOf(taskClass);
    if (typeof handler !== 'function') {
      throw new TypeError(`InProcessTaskStrategy.attach: the handler for task '${id}' is not a function`);
    }
    const list = this.handlers.get(id) ?? [];
    list.push(handler as Handler);
    this.handlers.set(id, list);
  }

  /**
   * @throws TaskDispatchFailedException, through the returned promise,
   *   when a check above fails
   */
  async dispatch(task: Task): Promise<void> {
    const id = this.idOf(task);
    const fail = (why: string, cause: unknown): TaskDispatchFailedException =>
      new TaskDispatchFailedException(`Task '${id}' dispatch failed: ${why}`, { cause });

    if ((this.handlers.get(id) ?? []).length === 0) {
      throw new TaskDispatchFailedException(`Task '${id}' dispatch failed: no handler is attached for it`);
    }

    let payload: unknown;
    try {
      payload = (task as Serializable).toPayload();
    } catch (error) {
      throw fail('toPayload threw', error);
    }
    if (payload === null || payload === undefined || Object.getPrototypeOf(payload) !== Object.prototype) {
      throw fail('the payload is not a plain object', new TypeError(`The payload of task '${id}' must be a plain object`));
    }

    let text: string;
    try {
      text = JSON.stringify(payload);
    } catch (error) {
      throw fail('JSON cannot carry the payload', error);
    }

    let rebuilt: Task;
    try {
      rebuilt = (task.constructor as unknown as Rebuildable).fromPayload(JSON.parse(text) as Record<string, unknown>);
    } catch (error) {
      throw fail('fromPayload threw', error);
    }

    this.queue.push({ id, task: rebuilt });
    this.schedule();
  }

  /**
   * Resolves once the queue is empty and no task is running, including
   * tasks that handlers dispatched while it waited. It never rejects,
   * since a failed task is logged, not thrown.
   */
  async whenIdle(): Promise<void> {
    if (this.isIdle()) return;
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /**
   * Check 1: the value is an object whose class has a usable static id,
   * read with `taskIdOf`, and which has a `toPayload` method.
   */
  private idOf(task: unknown): string {
    if (typeof task !== 'object' || task === null) {
      throw new TaskDispatchFailedException('Task dispatch failed: the value is not a task', {
        cause: new TypeError(`A task must be an object, not a value of type ${task === null ? 'null' : typeof task}`),
      });
    }
    let id: string;
    try {
      id = taskIdOf(task as Task);
    } catch (error) {
      throw new TaskDispatchFailedException('Task dispatch failed: the value is not a task', { cause: error });
    }
    if (typeof (task as Partial<Task>).toPayload !== 'function') {
      throw new TaskDispatchFailedException(`Task '${id}' dispatch failed: it has no toPayload method`, {
        cause: new TypeError(`Task '${id}' must have a toPayload method`),
      });
    }
    return id;
  }

  /**
   * Starts the next task on a later turn of the event loop, unless a task
   * is running or a turn is already scheduled. A running task schedules
   * the next one when it ends.
   */
  private schedule(): void {
    if (this.running || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.runNext();
    });
  }

  /** Runs the task at the head of the queue, then schedules the next. */
  private async runNext(): Promise<void> {
    const next = this.queue.shift();
    if (next !== undefined) {
      this.running = true;
      await this.run(next);
      this.running = false;
    }
    if (this.queue.length > 0) this.schedule();
    else this.settleIdle();
  }

  /**
   * Runs a task's handlers in attach order, each awaited. The first
   * failure ends the run and is reported, and later handlers do not run.
   */
  private async run({ id, task }: QueuedTask): Promise<void> {
    for (const handler of [...(this.handlers.get(id) ?? [])]) {
      try {
        await handler(task);
      } catch (error) {
        this.report(id, task, error);
        return;
      }
    }
  }

  /**
   * Logs a failed run at error level. When the logger throws, both
   * errors go to `console.error`, so the queue goes on and neither is
   * lost. A task whose own `idempotencyKey()` throws lands there too,
   * with that error as `loggerError`, since the report could not be made.
   */
  private report(id: string, task: Task, error: unknown): void {
    try {
      const context: LogContext = { task: id };
      const key = idempotencyKeyOf(task);
      if (key !== undefined) context.idempotencyKey = key;
      (this.logger as ExceptionLogger).logException(error, `Task '${id}' failed`, context, 'error');
    } catch (loggerError) {
      console.error(`Task '${id}' failed, and the logger threw while reporting it`, { task: id, error, loggerError });
    }
  }

  private isIdle(): boolean {
    // A scheduled turn always has a task queued, so the queue covers it.
    return !this.running && this.queue.length === 0;
  }

  /** Resolves every `whenIdle` waiter. Called only once the queue is empty and no task runs. */
  private settleIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** The task's idempotency key when it implements `IsIdempotent`. */
function idempotencyKeyOf(task: Task): unknown {
  const keyed = task as { idempotencyKey?: unknown } | null | undefined;
  return typeof keyed?.idempotencyKey === 'function' ? (keyed.idempotencyKey as () => unknown).call(task) : undefined;
}
