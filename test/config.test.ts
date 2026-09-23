import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAbi } from 'viem';
import { adaptDeployment } from '../src/adapt.ts';
import { readManifest, validateRpcUrl } from '../src/config.ts';
import { createRpc } from '../src/rpc.ts';

const address = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const abi = parseAbi(['event Deposit(address indexed owner,uint128 amount)', 'event Withdrawal(address indexed owner,uint128 amount)', 'event PendingRolled(address indexed owner,uint256[2] rolled)', 'event ConfidentialTransfer(address indexed from,address indexed to)']);
const deployment = {
  schemaVersion: 2, chainId: 31337, network: 'local', devOnly: true, rpcUrl: 'http://127.0.0.1:8568',
  registry: address, factory: address, verifiers: { transfer: address, withdraw: address, register: address },
  vaults: [{ address, verifierVersion: 2, fromBlock: '12' }, { address: other, verifierVersion: 2, fromBlock: '8' }],
};
test('deployment adapter preserves verifier metadata and individual deployment blocks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'saberent-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = adaptDeployment(deployment, abi);
  assert.deepEqual(result.verifiers, deployment.verifiers);
  assert.equal(result.fromBlock, '8');
  const file = join(directory, 'operator.json');
  await writeFile(file, JSON.stringify(result));
  const manifest = await readManifest(file);
  assert.equal(manifest.chainId, 31337);
  assert.equal(manifest.fromBlock, 8n);
  assert.deepEqual(manifest.vaults.map(vault => vault.fromBlock), [12n, 8n]);
});
test('local RPC must use HTTP(S) loopback even through an environment override', () => {
  for (const url of ['https://example.com', 'http://127.0.0.1.example.com', 'http://127.0.0.1@evil.example', 'file://localhost/tmp/rpc', 'http://192.168.1.2:8545']) {
    assert.throws(() => validateRpcUrl(url, 31337));
    assert.throws(() => createRpc(url, [], 31337));
  }
  for (const url of ['http://127.0.0.1:8545', 'http://[::1]:8545', 'http://localhost:8545']) assert.doesNotThrow(() => validateRpcUrl(url, 31337));
  assert.doesNotThrow(() => validateRpcUrl('https://example.com', 5042002));
  assert.throws(() => validateRpcUrl('https://example.com', 1));
});
test('local chain requires explicit development network and testnet identity cannot be replaced', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'saberent-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = adaptDeployment(deployment, abi);
  for (const override of [{ network: 'testnet' }, { devOnly: false }, { rpcUrl: 'https://remote.example' }, { chainId: 1 }, { rpcUrl: undefined }]) {
    const file = join(directory, 'invalid.json');
    await writeFile(file, JSON.stringify({ ...base, ...override }));
    await assert.rejects(readManifest(file));
  }
  assert.throws(() => adaptDeployment({ ...deployment, verifiers: undefined }, abi));
});
