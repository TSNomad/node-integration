/**
 * InMemoryEventStrategy from this package is the class @tsnomad/event
 * ships, so code that imports it from either package shares one class and
 * one bus. Runs now.
 */

import { describe, expect, test } from 'vitest';
import { Container } from '@tsnomad/di-container';
import * as event from '@tsnomad/event';
import { EventStrategy } from '@tsnomad/event';
import { InMemoryEventStrategy as FromSubpath } from '@tsnomad/event/in-memory-event-strategy';
import type { Event } from '@tsnomad/event';
import { InMemoryEventStrategy } from '@tsnomad/node-integration';

class Pinged implements Event {
  static getId(): string {
    return 'pinged';
  }
}

describe('InMemoryEventStrategy', () => {
  test('is the same class as the one @tsnomad/event exports', () => {
    expect(InMemoryEventStrategy).toBe(event.InMemoryEventStrategy);
    expect(InMemoryEventStrategy).toBe(FromSubpath);
  });

  test('a binding made with one import is found with the other, and gives one bus', async () => {
    const container = new Container();
    container.bind(InMemoryEventStrategy, EventStrategy, InMemoryEventStrategy);

    const byToken = await container.get(EventStrategy);
    const byEventImport = await container.get(event.InMemoryEventStrategy);
    let heard = 0;
    byEventImport.attach(Pinged, () => {
      heard++;
    });
    await byToken.broadcast(new Pinged());

    expect(byToken).toBe(byEventImport);
    expect(heard).toBe(1);
  });
});
