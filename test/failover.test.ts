import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFailoverRpc } from '../src/failover.ts';
import { OperatorError } from '../src/types.ts';
import type { Block, Rpc } from '../src/types.ts';

const block = (number: bigint): Block => ({ number, hash: `0x${number.toString(16).padStart(64, '0')}`, parentHash: `0x${'0'.repeat(64)}`, timestamp: 1_700_000_000n });

/** Recording endpoint. `fail` decides what the next call throws, if anything. */
function endpoint(id: string, fail: () => unknown = () => undefined) {
  const calls: string[] = [];
  const guard = async <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    const error = fail();
    if (error) throw error;
    return value;
  };
  const rpc: Rpc & { calls: string[]; id: string } = {
    id, calls,
    chainId: () => guard('chainId', 5042002),
    finalized: () => guard('finalized', block(100n)),
    block: (number: bigint) => guard('block', block(number)),
    events: () => guard('events', []),
    eventsRange: () => guard('eventsRange', []),
  };
  return rpc;
}

test('a transport failure fails over to the next endpoint and returns its answer', async () => {
  let down = true;
  const primary = endpoint('primary', () => (down ? new Error('ECONNREFUSED') : undefined));
  const secondary = endpoint('secondary');
  const rpc = createFailoverRpc([primary, secondary]);
  assert.equal(await rpc.chainId(), 5042002);
  assert.deepEqual(primary.calls, ['chainId']);
  assert.deepEqual(secondary.calls, ['chainId']);
  down = false;
});

test('inconsistent provider data never fails over and never reaches another endpoint', async () => {
  const primary = endpoint('primary', () => new OperatorError('RPC returned inconsistent event identity'));
  const secondary = endpoint('secondary');
  const rpc = createFailoverRpc([primary, secondary]);
  await assert.rejects(() => rpc.finalized(), (error: unknown) => {
    assert.ok(error instanceof OperatorError);
    assert.match((error as OperatorError).message, /inconsistent event identity/);
    return true;
  });
  // Shopping for an endpoint that agrees would hide a fork or a corrupt provider.
  assert.deepEqual(secondary.calls, []);
});

test('selection is sticky, so a recovered preference is not retried on every call', async () => {
  let primaryDown = true;
  const primary = endpoint('primary', () => (primaryDown ? new Error('ETIMEDOUT') : undefined));
  const secondary = endpoint('secondary');
  let clock = 0;
  const rpc = createFailoverRpc([primary, secondary], { now: () => clock, recoverAfterMs: 300_000 });
  await rpc.chainId();
  primaryDown = false;
  clock = 299_999;
  await rpc.finalized();
  await rpc.finalized();
  assert.deepEqual(primary.calls, ['chainId']);
  assert.deepEqual(secondary.calls, ['chainId', 'finalized', 'finalized']);
});

test('the preferred endpoint resumes serving once the cooldown elapses', async () => {
  let primaryDown = true;
  const primary = endpoint('primary', () => (primaryDown ? new Error('ETIMEDOUT') : undefined));
  const secondary = endpoint('secondary');
  let clock = 0;
  const rpc = createFailoverRpc([primary, secondary], { now: () => clock, recoverAfterMs: 300_000 });
  await rpc.chainId();
  primaryDown = false;
  clock = 300_000;
  await rpc.finalized();
  assert.deepEqual(primary.calls, ['chainId', 'finalized']);
  assert.deepEqual(secondary.calls, ['chainId']);
  clock = 300_001;
  await rpc.finalized();
  assert.deepEqual(secondary.calls, ['chainId'], 'preferred endpoint keeps serving once recovered');
});

test('every endpoint down surfaces the transport error instead of a silent success', async () => {
  const primary = endpoint('primary', () => new Error('ECONNREFUSED'));
  const secondary = endpoint('secondary', () => new Error('EHOSTUNREACH'));
  const rpc = createFailoverRpc([primary, secondary]);
  await assert.rejects(() => rpc.block(7n), /EHOSTUNREACH/);
  assert.deepEqual(primary.calls, ['block']);
  assert.deepEqual(secondary.calls, ['block']);
});

test('each endpoint is attempted at most once per call', async () => {
  const primary = endpoint('primary', () => new Error('ECONNREFUSED'));
  const secondary = endpoint('secondary', () => new Error('ECONNREFUSED'));
  const third = endpoint('third', () => new Error('ECONNREFUSED'));
  const rpc = createFailoverRpc([primary, secondary, third]);
  await assert.rejects(() => rpc.chainId());
  for (const item of [primary, secondary, third]) assert.equal(item.calls.length, 1, `${item.id} retried`);
});

test('the bounded range query is exposed only when every endpoint implements it', () => {
  const full = endpoint('full');
  const partial = endpoint('partial');
  delete (partial as { eventsRange?: unknown }).eventsRange;
  assert.equal(typeof createFailoverRpc([full, endpoint('other')]).eventsRange, 'function');
  assert.equal(createFailoverRpc([full, partial]).eventsRange, undefined);
});

test('a failover set must not be empty and its recovery interval must be valid', () => {
  assert.throws(() => createFailoverRpc([]), /at least one endpoint/);
  assert.throws(() => createFailoverRpc([endpoint('a')], { recoverAfterMs: -1 }), /recovery interval/);
});
