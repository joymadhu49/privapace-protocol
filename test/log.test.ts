import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FaultLog, guardPoolFaults } from '../src/log.ts';

const base = Date.parse('2026-09-19T23:10:00.000Z');

test('a persisting fault is reported once, then summarised on an interval', () => {
  const log = new FaultLog(300_000);
  const first = log.observe('RPC or database operation failed', base);
  assert.match(first!, /^2026-09-19T23:10:00\.000Z indexer paused: RPC or database/);
  // Two-second ticks through the next five minutes stay quiet.
  for (let tick = 2_000; tick < 300_000; tick += 2_000) {
    assert.equal(log.observe('RPC or database operation failed', base + tick), null);
  }
  const repeat = log.observe('RPC or database operation failed', base + 300_000);
  assert.match(repeat!, /indexer still paused after 5m and 151 failed passes/);
});

test('recovery is always reported with the outage duration and failed pass count', () => {
  const log = new FaultLog(300_000);
  log.observe('RPC or database operation failed', base);
  log.observe('RPC or database operation failed', base + 2_000);
  const recovered = log.observe(null, base + 32_040_000);
  assert.match(recovered!, /indexer recovered after 32040s and 2 failed passes/);
  assert.match(recovered!, /last fault: RPC or database operation failed/);
  assert.equal(log.observe(null, base + 32_042_000), null, 'healthy passes stay silent');
});

test('a different fault is reported immediately rather than folded into the previous one', () => {
  const log = new FaultLog(300_000);
  log.observe('RPC chain ID mismatch', base);
  const changed = log.observe('Witness has not finalized primary head', base + 2_000);
  assert.match(changed!, /indexer paused: Witness has not finalized primary head/);
});

test('an invalid repeat interval is rejected', () => {
  assert.throws(() => new FaultLog(0), /repeat interval/);
});

test('an idle database connection fault is contained instead of crashing the process', () => {
  const pool = new EventEmitter();
  const lines: string[] = [];
  guardPoolFaults(pool, line => lines.push(line), () => base);
  // Without a listener this emit throws and terminates the operator.
  assert.doesNotThrow(() => pool.emit('error', new Error('terminating connection due to administrator command')));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^2026-09-19T23:10:00\.000Z database pool discarded a failed idle connection/);
});

test('a database fault line never repeats the raw driver error', () => {
  const pool = new EventEmitter();
  const lines: string[] = [];
  guardPoolFaults(pool, line => lines.push(line), () => base);
  const raw = 'password=hunter2 terminating connection due to administrator command';
  pool.emit('error', new Error(raw));
  assert.doesNotMatch(lines[0]!, /password|hunter2|administrator command/);
});
