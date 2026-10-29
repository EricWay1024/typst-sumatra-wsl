import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForMapper } from './typst-sumatra.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('ready mappers and actual compilation failures retain their result', async () => {
  assert.equal(await waitForMapper(Promise.resolve('ready'), { deadline: Date.now() + 1000 }), 'ready');
  await assert.rejects(waitForMapper(Promise.reject(Error('compilation failed')), {
    deadline: Date.now() + 1000,
  }), /compilation failed/);
});

test('an interactive timeout leaves shared preparation usable by a later request', async () => {
  let finish;
  const starting = new Promise(resolve => { finish = resolve; });
  await assert.rejects(waitForMapper(starting, { deadline: Date.now() + 5 }), /still preparing.*background/);
  finish('ready');
  assert.equal(await waitForMapper(starting, { deadline: Date.now() + 1000 }), 'ready');
});

test('disconnected clicks stop waiting without cancelling shared preparation', async () => {
  let finish, cancelled = false;
  const starting = new Promise(resolve => { finish = resolve; });
  const result = waitForMapper(starting, { deadline: Date.now() + 1000, cancelled: () => cancelled });
  cancelled = true;
  await assert.rejects(result, /Source lookup cancelled/);
  finish('ready');
  assert.equal(await waitForMapper(starting, { deadline: Date.now() + 1000 }), 'ready');
});

test('preparation rejection after an abandoned click is still observed', async () => {
  let fail;
  const starting = new Promise((_, reject) => { fail = reject; });
  await assert.rejects(waitForMapper(starting, { deadline: 0 }), /still preparing/);
  fail(Error('later mapper failure'));
  await pause(50); // node:test would fail this test on an unhandled rejection.
});

test('native compilation failure or revision changes interrupt the warmup wait', async () => {
  let changed = false, finish;
  const starting = new Promise(resolve => { finish = resolve; });
  const result = waitForMapper(starting, { deadline: Date.now() + 1000,
    check: () => { if (changed) throw Error('PDF changed'); } });
  changed = true;
  await assert.rejects(result, /PDF changed/);
  finish();
});
