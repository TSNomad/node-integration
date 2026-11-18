# @tsnomad/node-integration

The strategies a plain Node process needs, with nothing beyond Node
itself, and the initializer that binds them:

| Class | Implements |
|---|---|
| `NativeFetchStrategy` | `FetchStrategy`, over Node's `fetch` |
| `ConsoleLoggerStrategy` | `LoggerStrategy`, over Node's console |
| `InProcessTaskStrategy` | `TaskStrategy`, in the same process |
| `InMemoryEventStrategy` | `EventStrategy`, the class `@tsnomad/event` ships |
| `Response` | `Response` from `@tsnomad/http` |
| `NodeResponseFactory` | `ResponseFactory`, a new `Response` per call |
| `NodeInitializer` | binds the four strategies and the factory |

It plays the role PHPNomad's platform integrations play, such as
[guzzle-fetch-integration](https://github.com/phpnomad/guzzle-fetch-integration).

## Install

```bash
npm install @tsnomad/node-integration
```

The package ships compiled JavaScript with its type declarations, so
it needs no build step of its own. It needs Node 20.19 or later.
npm installs the TS Nomad packages it depends on with it.

`scripts/consumer-check.sh [<commit>]` installs the package from git at
one commit into a scratch project and imports every export, from Node
and from TypeScript.

## Where it fits

This is the integration layer for a plain Node process. It implements
the contracts from `@tsnomad/http`, `@tsnomad/logger`, `@tsnomad/fetch`
and `@tsnomad/tasks`, binds them with `NodeInitializer` through
`@tsnomad/loader`, and uses `@tsnomad/event` for events.
`@tsnomad/medusa-integration` builds on it.

## Use

```ts
import { Container } from '@tsnomad/di-container';
import { Bootstrapper } from '@tsnomad/loader';
import { NodeInitializer } from '@tsnomad/node-integration';

const container = new Container();
await new Bootstrapper(container, new NodeInitializer(), new AppInitializer()).load();
```

`NodeInitializer` binds each strategy and the factory under its
interface token and its own class, so both reach one instance, and
`RestLifecycle` autowires from the container. Load it before the application's
own initializers.

`InMemoryEventStrategy` is the same class as the one `@tsnomad/event`
exports, so either import gives one bus. Its source moves here at the
event package's next major release.

## Where this differs from PHPNomad

- `NativeFetchStrategy` never follows a redirect, where Guzzle follows
  them by default. It answers every status, and rejects with
  `FetchException` only when there is no complete response. The
  timeout, 30 seconds by default, covers the body read.
- `NativeFetchStrategy` adds a payload's params after the query the URL
  already has, keeping both when a name repeats. WordPress's
  `add_query_arg` replaces a param of the same name, and Guzzle's `query`
  option replaces the whole query.
- `NativeFetchStrategy` refuses a URL with a user name or password with
  a `TypeError`, since Node's fetch will not send one. A header the
  server sent more than once holds every value joined with `, `, as
  Guzzle's response does.
- `Response` refuses a status outside 100 to 599 and a value JSON cannot
  encode, `getJson()` throws for a body that is not JSON, and header
  names compare without regard to case.
- `NodeResponseFactory` is new, since PHPNomad has no response factory.
- `InProcessTaskStrategy` has no PHPNomad counterpart. It follows the
  Redis worker's rules: each task is rebuilt from its payload, its
  handlers run in order, and the first failure ends the task and is
  logged. It logs that failure at error level, where the Redis worker
  logs at the default critical level, since the queue carries on. It
  checks every task at dispatch, refuses one with no handler, keeps no
  idempotency store, and adds `whenIdle()`. Its failure log names the
  task, `Task '<id>' failed`, with the task id and any idempotency key as
  context, and it writes no info line per handler as the Redis worker
  does.
- `ConsoleLoggerStrategy` filters no level.
- `NodeInitializer` binds each strategy under its own class as well as
  its interface, and both names reach one instance. PHPNomad's platform
  initializers bind only the interface, so resolving the concrete class
  there builds a second instance.

## Extracted 2026-11-17

This package moved into its own repository on 2026-11-17, at version
0.1.0, with its tests.

## License

Copyright (C) 2026 TSNomad.

This package is free software, released under the GNU General Public
License, version 3 or any later version (GPL-3.0-or-later). It comes
with no warranty. The full text is in [LICENSE](LICENSE).
