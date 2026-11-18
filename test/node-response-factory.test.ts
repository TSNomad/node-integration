/**
 * Tests for NodeResponseFactory.
 */

import { expect, test } from 'vitest';
import { NodeResponseFactory, Response } from '@tsnomad/node-integration';

test('create answers a new Response from this package on every call', () => {
  const factory = new NodeResponseFactory();

  const first = factory.create();
  const second = factory.create();

  expect(first).toBeInstanceOf(Response);
  expect(second).toBeInstanceOf(Response);
  expect(second).not.toBe(first);
});
