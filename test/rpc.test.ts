import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodeAbiParameters, parseAbi, toEventSelector } from 'viem';
import { createRpc } from '../src/rpc.ts';

const address = '0x1111111111111111111111111111111111111111';
const hash = `0x${'ab'.repeat(32)}`;
const abi = parseAbi(['event Deposit(uint256 amount)']);
test('RPC range query is bounded, decodes real logs, and rejects malformed identities', async t => {
  let mode = 'valid';
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const log = {
      address: mode === 'address' ? '0x2222222222222222222222222222222222222222' : address,
      topics: [toEventSelector('Deposit(uint256)')], data: encodeAbiParameters([{ type: 'uint256' }], [10n]),
      blockNumber: mode === 'height' ? '0xc' : '0xa', blockHash: mode === 'hash' ? null : hash,
      transactionHash: hash, transactionIndex: '0x0', logIndex: '0x1', removed: mode === 'removed',
    };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: mode === 'duplicate' ? [log, log] : [log] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const rpc = createRpc(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, [{ address, abi, fromBlock: 10n }], 31337);
  assert.equal(typeof rpc.eventsRange, 'function');
  const rows = await rpc.eventsRange!(9n, 11n);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, [{ address, topics: [], fromBlock: '0xa', toBlock: '0xb' }]);
  assert.equal(rows[0]!.blockNumber, '10');
  assert.deepEqual(rows[0]!.args, { amount: 10n });
  for (mode of ['height', 'hash', 'address', 'removed', 'duplicate']) await assert.rejects(rpc.eventsRange!(10n, 11n), /inconsistent|duplicate/, mode);
});
