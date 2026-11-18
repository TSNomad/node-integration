/**
 * Acceptance tests for the in-memory Response.
 */

import { describe, expect, test } from 'vitest';
import { Response } from '@tsnomad/node-integration';

describe('Response', () => {
  test('starts at status 200 with no headers, an empty body and no error', () => {
    const response = new Response();

    expect(response.getStatus()).toBe(200);
    expect(response.getHeaders()).toEqual({});
    expect(response.getBody()).toBe('');
    expect(response.getErrorMessage()).toBeNull();
    expect(response.getResponse()).toEqual({ status: 200, headers: {}, body: '', error: null });
  });

  test('every setter returns the response, so calls chain', () => {
    const response = new Response();

    expect(response.setStatus(201)).toBe(response);
    expect(response.setHeader('X-Id', '1')).toBe(response);
    expect(response.setBody('b')).toBe(response);
    expect(response.setJson({})).toBe(response);
    expect(response.setError('e')).toBe(response);
  });

  test('takes any status from 100 to 599 and refuses the rest', () => {
    const response = new Response();
    for (const code of [100, 204, 302, 404, 599]) expect(response.setStatus(code).getStatus()).toBe(code);
    for (const code of [99, 600, 0, -200, 200.5, Number.NaN]) {
      expect(() => response.setStatus(code), String(code)).toThrow(RangeError);
    }
    expect(() => response.setStatus('200' as never)).toThrow(RangeError);
    expect(response.getStatus()).toBe(599);
  });

  test('stores header names in lower case, so any case finds and replaces them', () => {
    const response = new Response().setHeader('Content-Type', 'text/plain').setHeader('X-ID', '1');

    expect(response.getHeader('content-type')).toBe('text/plain');
    expect(response.getHeader('CONTENT-TYPE')).toBe('text/plain');
    expect(response.getHeaders()).toEqual({ 'content-type': 'text/plain', 'x-id': '1' });

    response.setHeader('content-TYPE', 'text/html');
    expect(response.getHeaders()).toEqual({ 'content-type': 'text/html', 'x-id': '1' });
    expect(response.getHeader('missing')).toBeNull();
  });

  test('answers copies of its headers and of its snapshot, so changing them leaves the response alone', () => {
    const response = new Response().setHeader('a', '1').setBody('x');
    response.getHeaders().a = 'changed';
    const snapshot = response.getResponse();
    snapshot.status = 500;
    snapshot.headers.a = 'changed';
    snapshot.body = 'changed';

    expect(response.getHeaders()).toEqual({ a: '1' });
    expect(response.getResponse()).toEqual({ status: 200, headers: { a: '1' }, body: 'x', error: null });
  });

  test('setJson encodes the value and sets the JSON content type, and getJson decodes any JSON value', () => {
    const response = new Response().setJson({ ok: true, items: [1, 'two'] });

    expect(response.getBody()).toBe('{"ok":true,"items":[1,"two"]}');
    expect(response.getHeader('content-type')).toBe('application/json');
    expect(response.getJson()).toEqual({ ok: true, items: [1, 'two'] });
    expect(new Response().setJson(null).getBody()).toBe('null');
    expect(new Response().setBody('[1,2]').getJson()).toEqual([1, 2]);
    expect(new Response().setBody('"text"').getJson()).toBe('text');
  });

  test('setJson refuses a value JSON cannot encode with a TypeError, and leaves the response unchanged', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of [undefined, () => 1, 10n, circular, Symbol('s')]) {
      const response = new Response().setBody('before').setHeader('content-type', 'text/plain');
      expect(() => response.setJson(value), typeof value).toThrow(TypeError);
      expect(response.getBody()).toBe('before');
      expect(response.getHeader('content-type')).toBe('text/plain');
    }
  });

  test('getJson throws a SyntaxError for a body that is not JSON, the empty body included', () => {
    expect(() => new Response().getJson()).toThrow(SyntaxError);
    expect(() => new Response().setBody('not json').getJson()).toThrow(SyntaxError);
  });

  test('setError sets the status, 400 by default, records the message and sets the JSON error body', () => {
    const response = new Response().setError('Bad signature');

    expect(response.getStatus()).toBe(400);
    expect(response.getErrorMessage()).toBe('Bad signature');
    expect(response.getJson()).toEqual({ error: 'Bad signature' });
    expect(response.getHeader('content-type')).toBe('application/json');
    expect(response.getResponse()).toEqual({
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: '{"error":"Bad signature"}',
      error: 'Bad signature',
    });
    expect(new Response().setError('Down', 503).getStatus()).toBe(503);
    expect(() => new Response().setError('x', 700)).toThrow(RangeError);
  });
});
