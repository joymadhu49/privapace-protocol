import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Indexer } from '../src/indexer.ts';
import { createApi } from '../src/http.ts';
import { canonical, defaultCheckpointBlock, historyDigest } from '../src/checkpoint.ts';
import type { Block, Checkpoint, IndexedEvent, Rpc, Store } from '../src/types.ts';

const vault = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const now = 1_800_000_000_000;
class MemoryStore implements Store {
  cursor: Checkpoint | null = null;
  rows: IndexedEvent[] = [];
  async checkpoint() { return this.cursor; }
  async commit(block: Block, _expected: Checkpoint | null, rows: IndexedEvent[]) { this.rows.push(...rows); this.cursor = { number: block.number, hash: block.hash }; }
  async events(address: string, after: { block: bigint; log: number } | null, limit: number, through: bigint) {
    return this.rows.filter(row => BigInt(row.blockNumber) <= through && row.vault === address && (!after || BigInt(row.blockNumber) > after.block || (BigInt(row.blockNumber) === after.block && row.logIndex > after.log))).slice(0, limit);
  }
}
class FakeRpc implements Rpc {
  height = 2500n;
  async chainId() { return 5042002; }
  async finalized() { return this.block(this.height); }
  async block(number: bigint): Promise<Block> { return { number, hash: `hash-${number}`, parentHash: `hash-${number - 1n}`, timestamp: BigInt(now / 1000) }; }
  async events(block: Block): Promise<IndexedEvent[]> {
    return block.number % 400n === 0n ? [{ vault, blockNumber: block.number.toString(), blockHash: block.hash, transactionHash: `tx-${block.number}`, logIndex: 0, eventName: 'Deposit', args: { amount: '1', account: '0xabc' } }] : [];
  }
}
const event = (vaultAddress: string, block: number, log: number, args: unknown): IndexedEvent =>
  ({ vault: vaultAddress, blockNumber: String(block), blockHash: `0xH${block}`, transactionHash: `0xT${block}`, logIndex: log, eventName: 'Deposit', args });

test('canonical JSON sorts keys recursively and is order independent', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 10n } }), '{"a":{"c":"10","d":[2,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonical({ x: 1, y: 2 }), canonical({ y: 2, x: 1 }));
});

test('history digest matches across key order, vault order and page size', async () => {
  const one = new MemoryStore();
  one.rows = [event(vault, 10, 0, { amount: '5', to: '0x1' }), event(vault, 10, 1, { amount: '6' }), event(other, 12, 0, { amount: '7' })];
  const two = new MemoryStore();
  two.rows = [event(other, 12, 0, { amount: '7' }), event(vault, 10, 0, { to: '0x1', amount: '5' }), event(vault, 10, 1, { amount: '6' })];
  const a = await historyDigest(one, [vault, other], 20n);
  const b = await historyDigest(two, [other, vault.toUpperCase().replace('0X', '0x')], 20n, 1);
  assert.deepEqual(a, b);
  assert.equal(a.eventCount, 3);
});

test('history digest excludes later blocks and detects any changed event', async () => {
  const store = new MemoryStore();
  store.rows = [event(vault, 10, 0, { amount: '5' }), event(vault, 30, 0, { amount: '9' })];
  const through20 = await historyDigest(store, [vault], 20n);
  assert.equal(through20.eventCount, 1);
  store.rows[1] = event(vault, 30, 0, { amount: '10' });
  assert.deepEqual(await historyDigest(store, [vault], 20n), through20);
  store.rows[0] = event(vault, 10, 0, { amount: '50' });
  assert.notEqual((await historyDigest(store, [vault], 20n)).historySha256, through20.historySha256);
});

test('default checkpoint rounds down to a shared interval', () => {
  assert.equal(defaultCheckpointBlock(63612631n), 63612000n);
  assert.equal(defaultCheckpointBlock(63612000n), 63612000n);
});

test('checkpoint endpoint serves a comparable digest only for finalized history', async t => {
  const store = new MemoryStore();
  const indexer = new Indexer(new FakeRpc(), store, 1n, { now: () => now, batchSize: 500 });
  const api = createApi(indexer, store, [vault], 'scope-1');
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/checkpoint`)).status, 503);
  for (let i = 0; i < 10 && !indexer.healthy(); i++) await indexer.tick();
  const body = await (await fetch(`${base}/checkpoint`)).json();
  assert.equal(body.algorithm, 'privapace-history-v1');
  assert.equal(body.scope, 'scope-1');
  assert.equal(body.block, '2000');
  assert.equal(body.eventCount, 5);
  assert.equal(body.indexedBlock, '2500');
  assert.equal(body.caughtUp, true);
  const explicit = await (await fetch(`${base}/checkpoint?block=2000`)).json();
  assert.equal(explicit.historySha256, body.historySha256);
  assert.equal((await fetch(`${base}/checkpoint?block=2501`)).status, 409);
  assert.equal((await fetch(`${base}/checkpoint?block=-1`)).status, 400);
  assert.equal((await fetch(`${base}/checkpoint?block=1e3`)).status, 400);
});

test('a catching-up operator serves checkpoints below its index but a faulted one does not', async t => {
  const store = new MemoryStore();
  const indexer = new Indexer(new FakeRpc(), store, 1n, { now: () => now, batchSize: 500 });
  const api = createApi(indexer, store, [vault]);
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  await indexer.tick();
  assert.equal(indexer.healthy(), false);
  const partial = await (await fetch(`${base}/checkpoint?block=400`)).json();
  assert.equal(partial.caughtUp, false);
  assert.equal(partial.eventCount, 1);
  assert.equal((await fetch(`${base}/checkpoint?block=600`)).status, 409);
  indexer.state.error = 'RPC disagreement at block 501';
  assert.equal((await fetch(`${base}/checkpoint?block=400`)).status, 503);
});
