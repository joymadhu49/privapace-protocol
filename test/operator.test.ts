import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Indexer } from '../src/indexer.ts';
import { createApi } from '../src/http.ts';
import type { Block, Checkpoint, IndexedEvent, Rpc, Store } from '../src/types.ts';

const vault = '0x1111111111111111111111111111111111111111';
const now = 1_800_000_000_000;
class MemoryStore implements Store {
  cursor: Checkpoint | null = null;
  rows: IndexedEvent[] = [];
  fail = false;
  async checkpoint() { return this.cursor; }
  async commit(block: Block, expected: Checkpoint | null, rows: IndexedEvent[]) {
    assert.deepEqual(this.cursor, expected);
    if (this.fail) throw new Error('simulated transaction failure');
    const staged = [...this.rows, ...rows];
    assert.equal(new Set(staged.map(row => `${row.blockNumber}:${row.logIndex}`)).size, staged.length);
    this.rows = staged;
    this.cursor = { number: block.number, hash: block.hash };
  }
  async events(address: string, after: { block: bigint; log: number } | null, limit: number, through: bigint) {
    return this.rows.filter(row => BigInt(row.blockNumber) <= through && row.vault === address && (!after || BigInt(row.blockNumber) > after.block || (BigInt(row.blockNumber) === after.block && row.logIndex > after.log))).slice(0, limit);
  }
}
class FakeRpc implements Rpc {
  height = 3n;
  chain = 5042002;
  changes = new Map<bigint, string>();
  stale = false;
  wrongEvent = false;
  async chainId() { return this.chain; }
  async finalized() { return this.block(this.height); }
  async block(number: bigint): Promise<Block> {
    return { number, hash: this.changes.get(number) ?? `hash-${number}`, parentHash: this.changes.get(number - 1n) ?? `hash-${number - 1n}`, timestamp: BigInt(now / 1000 - (this.stale ? 600 : 0)) };
  }
  async events(block: Block): Promise<IndexedEvent[]> {
    return [{ vault, blockNumber: block.number.toString(), blockHash: this.wrongEvent ? 'incorrect-hash' : block.hash, transactionHash: `tx-${block.number}`, logIndex: 0, eventName: 'Deposit', args: { amount: '12000000' } }];
  }
}
function fixture(options = {}) {
  const rpc = new FakeRpc();
  const store = new MemoryStore();
  const indexer = new Indexer(rpc, store, 1n, { now: () => now, ...options });
  return { rpc, store, indexer };
}
test('indexes only finalized blocks and resumes after restart without duplicates', async () => {
  const { rpc, store, indexer } = fixture({ batchSize: 2 });
  await indexer.tick();
  assert.equal(store.cursor?.number, 2n);
  assert.equal(indexer.healthy(), false);
  const restart = new Indexer(rpc, store, 1n, { now: () => now });
  await restart.tick();
  await restart.tick();
  assert.equal(store.rows.length, 3);
  assert.equal(restart.healthy(), true);
});
test('failed atomic commit does not advance cursor or append partial events', async () => {
  const { store, indexer } = fixture();
  store.fail = true;
  await indexer.tick();
  assert.equal(store.cursor, null);
  assert.equal(store.rows.length, 0);
  assert.equal(indexer.healthy(), false);
  store.fail = false;
  await indexer.tick();
  assert.equal(store.rows.length, 3);
});
test('checkpoint hash change fails closed and preserves existing history', async () => {
  const { rpc, store, indexer } = fixture();
  await indexer.tick();
  rpc.changes.set(3n, 'reorg');
  rpc.height = 4n;
  await indexer.tick();
  assert.match(indexer.state.error!, /checkpoint hash changed/);
  assert.equal(store.cursor?.hash, 'hash-3');
  assert.equal(store.rows.length, 3);
  assert.equal(indexer.healthy(), false);
});
test('RPC disagreement never confirms or indexes disputed history', async () => {
  const witness = new FakeRpc();
  witness.changes.set(2n, 'disputed');
  const { store, indexer } = fixture({ witness });
  await indexer.tick();
  assert.match(indexer.state.error!, /disagreement/);
  assert.equal(store.cursor?.number, 1n);
  assert.equal(indexer.healthy(), false);
});
test('witness must also have finalized primary head', async () => {
  const witness = new FakeRpc();
  witness.height = 2n;
  const { store, indexer } = fixture({ witness });
  await indexer.tick();
  assert.equal(store.cursor, null);
  assert.match(indexer.state.error!, /not finalized/);
});
test('stale RPC, wrong chain and inconsistent event identities cannot advance cursor', async () => {
  for (const condition of ['stale', 'wrong-chain', 'wrong-event']) {
    const { rpc, store, indexer } = fixture();
    if (condition === 'stale') rpc.stale = true;
    if (condition === 'wrong-chain') rpc.chain = 1;
    if (condition === 'wrong-event') rpc.wrongEvent = true;
    await indexer.tick();
    assert.equal(store.cursor, null);
    assert.equal(indexer.healthy(), false);
  }
});
test('health expires when indexing stops even after a successful pass', async () => {
  let clock = now;
  const { indexer } = fixture({ now: () => clock });
  await indexer.tick();
  assert.equal(indexer.healthy(), true);
  clock += 120_001;
  assert.equal(indexer.healthy(), false);
});
test('upstream errors do not expose RPC credentials in health state', async () => {
  const { rpc, indexer } = fixture();
  rpc.finalized = async () => { throw new Error('Request failed https://provider.example/secret-api-key'); };
  await indexer.tick();
  assert.equal(indexer.healthy(), false);
  assert.doesNotMatch(JSON.stringify(indexer.state), /secret-api-key/);
});
test('manifest start block beyond finality cannot report ready', async () => {
  const rpc = new FakeRpc();
  const store = new MemoryStore();
  const indexer = new Indexer(rpc, store, 4n, { now: () => now });
  await indexer.tick();
  assert.equal(indexer.healthy(), false);
  assert.equal(store.cursor, null);
});
test('HTTP bounds pagination, restricts vaults/methods and suppresses history while unhealthy', async t => {
  const { store, indexer, rpc } = fixture();
  const api = createApi(indexer, store, [vault]);
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/health`)).status, 503);
  await indexer.tick();
  const first = await (await fetch(`${base}/vaults/${vault}/events?limit=2`)).json();
  assert.equal(first.events.length, 2);
  assert.equal(first.nextCursor, '2:0');
  assert.equal(first.finality, 'rpc-finalized');
  assert.equal(first.indexedThrough, '3');
  assert.equal(first.indexedBlockHash, 'hash-3');
  const second = await (await fetch(`${base}/vaults/${vault}/events?limit=2&after=${first.nextCursor}`)).json();
  assert.equal(second.events.length, 1);
  assert.equal(second.nextCursor, null);
  for (const query of ['limit=201', 'limit=0', 'limit=-1', 'after=garbage', 'after=0:999999999999']) assert.equal((await fetch(`${base}/vaults/${vault}/events?${query}`)).status, 400);
  assert.equal((await fetch(`${base}/vaults/0x2222222222222222222222222222222222222222/events`)).status, 404);
  assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 405);
  rpc.stale = true;
  await indexer.tick();
  assert.equal((await fetch(`${base}/vaults/${vault}/events`)).status, 503);
});
test('HTTP refuses a history response when health or checkpoint changes during the database await', async t => {
  for (const change of ['disagreement', 'advanced', 'recovered']) {
    const witness = new FakeRpc();
    const { store, indexer, rpc } = fixture({ witness });
    await indexer.tick();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const querying = new Promise<void>(resolve => { entered = resolve; });
    const original = store.events.bind(store);
    store.events = async (address, after, limit, through) => {
      assert.equal(through, 3n, 'query must be bounded to the captured checkpoint');
      entered();
      await gate;
      return original(address, after, limit, through);
    };
    const api = createApi(indexer, store, [vault]);
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve())));
    const response = fetch(`http://127.0.0.1:${(api.address() as AddressInfo).port}/vaults/${vault}/events`);
    await querying;
    if (change === 'advanced') { rpc.height = 4n; witness.height = 4n; }
    else witness.changes.set(3n, 'disputed');
    await indexer.tick();
    if (change === 'recovered') { witness.changes.clear(); await indexer.tick(); assert.equal(indexer.healthy(), true); }
    release();
    assert.equal((await response).status, 503, change);
  }
});
test('history upper bound excludes newer database rows from a captured checkpoint', async () => {
  const { rpc, store, indexer } = fixture();
  await indexer.tick();
  rpc.height = 4n;
  await indexer.tick();
  const page = await store.events(vault, null, 50, 3n);
  assert.deepEqual(page.map(event => event.blockNumber), ['1', '2', '3']);
});
test('explicit local chain is indexed and reported as local rather than testnet', async t => {
  const { rpc, store, indexer } = fixture({ chainId: 31337 });
  rpc.chain = 31337;
  await indexer.tick();
  const api = createApi(indexer, store, [vault]);
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  assert.equal((await (await fetch(`${base}/health`)).json()).chainId, 31337);
  assert.equal((await (await fetch(`${base}/vaults/${vault}/events`)).json()).chainId, 31337);
});

test('parallel reads stay bounded and commit in height order despite out-of-order completion', async () => {
  const { rpc, store, indexer } = fixture({ concurrency: 3 });
  let active = 0;
  let peak = 0;
  const completed: string[] = [];
  const original = rpc.events.bind(rpc);
  rpc.events = async block => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, Number(4n - block.number) * 10));
    active--;
    completed.push(block.number.toString());
    return original(block);
  };
  await indexer.tick();
  assert.equal(peak, 3);
  assert.deepEqual(completed, ['3', '2', '1']);
  assert.deepEqual(store.rows.map(row => row.blockNumber), ['1', '2', '3']);
  assert.equal(indexer.healthy(), true);
});

test('parallel failure never skips a block and restart resumes without duplication', async () => {
  const { rpc, store, indexer } = fixture({ concurrency: 3 });
  const original = rpc.events.bind(rpc);
  rpc.events = async block => {
    if (block.number === 2n) throw new Error('provider unavailable');
    return original(block);
  };
  await indexer.tick();
  assert.equal(store.cursor?.number, 1n);
  assert.equal(store.rows.length, 1);
  assert.equal(indexer.healthy(), false);
  rpc.events = original;
  await indexer.tick();
  assert.deepEqual(store.rows.map(row => row.blockNumber), ['1', '2', '3']);
  assert.equal(indexer.healthy(), true);
});

test('parallel windows preserve parent, final-head and post-log identity checks', async () => {
  for (const condition of ['parent', 'head', 'post-log']) {
    const { rpc, store, indexer } = fixture({ concurrency: 3 });
    const block = rpc.block.bind(rpc);
    const reads = new Map<bigint, number>();
    rpc.block = async height => {
      const count = (reads.get(height) ?? 0) + 1;
      reads.set(height, count);
      const value = await block(height);
      if (condition === 'parent' && height === 2n) value.parentHash = 'wrong-parent';
      if (condition === 'head' && height === 3n && count > 1) value.hash = 'changed-head';
      if (condition === 'post-log' && height === 2n && count > 1) value.hash = 'changed-after-logs';
      return value;
    };
    await indexer.tick();
    assert.equal(indexer.healthy(), false, condition);
    assert.equal(store.cursor?.number, condition === 'head' ? 2n : 1n, condition);
  }
});

test('invalid concurrency and batch bounds are rejected before indexing', () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, 501]) assert.throws(() => fixture({ batchSize: value }));
  for (const value of [0, -1, NaN, Infinity, 1.5, 17]) assert.throws(() => fixture({ concurrency: value }));
});

test('bounded range logs avoid per-block log rate limits without changing indexed history', async () => {
  const { rpc, store, indexer } = fixture({ concurrency: 3, batchSize: 2 });
  const original = rpc.events.bind(rpc);
  const ranges: string[] = [];
  Object.assign(rpc, { eventsRange: async (from: bigint, through: bigint) => {
    ranges.push(`${from}:${through}`);
    const rows: IndexedEvent[] = [];
    for (let height = from; height <= through; height++) rows.push(...await original(await rpc.block(height)));
    return rows;
  } });
  rpc.events = async () => { throw new Error('per-block log request limit exceeded'); };
  await indexer.tick();
  await indexer.tick();
  assert.equal(indexer.healthy(), true);
  assert.deepEqual(ranges, ['1:2', '3:3']);
  assert.deepEqual(store.rows.map(row => row.blockNumber), ['1', '2', '3']);
});

test('range results cannot smuggle events outside the batch or with a different block hash', async () => {
  for (const mode of ['outside', 'changed']) {
    const { rpc, store, indexer } = fixture({ batchSize: 2 });
    const original = rpc.events.bind(rpc);
    Object.assign(rpc, { eventsRange: async () => {
      const rows = await original(await rpc.block(mode === 'outside' ? 3n : 1n));
      if (mode === 'changed') rows[0]!.blockHash = 'changed';
      return rows;
    } });
    await indexer.tick();
    assert.equal(store.cursor, null);
    assert.equal(indexer.healthy(), false);
    assert.match(indexer.state.error!, /outside requested|identity mismatch/);
  }
});
