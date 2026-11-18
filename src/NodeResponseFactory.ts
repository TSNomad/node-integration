/**
 * NodeResponseFactory
 *
 * The `ResponseFactory` for a plain Node process. Each `create()` answers
 * a new in-memory `Response` from this package, so concurrent requests
 * never share one. `NodeInitializer` binds it under the `ResponseFactory`
 * token, which is what `RestLifecycle` asks for.
 *
 * Where this differs from PHPNomad: PHPNomad has no response factory. See
 * `ResponseFactory` in @tsnomad/http.
 */

import type { ResponseFactory } from '@tsnomad/http';
import { Response } from './Response.js';

export class NodeResponseFactory implements ResponseFactory {
  create(): Response {
    return new Response();
  }
}
