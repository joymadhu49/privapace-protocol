import { resolve } from 'node:path';
import pg from 'pg';
import { readManifest } from './config.ts';
import { PostgresStore } from './store.ts';
import { createRpc } from './rpc.ts';
import { createFailoverRpc } from './failover.ts';
import { Indexer } from './indexer.ts';
import { createApi } from './http.ts';
import { FaultLog, guardPoolFaults } from './log.ts';

const manifest = await readManifest(resolve(process.env.SABERENT_MANIFEST ?? 'deployments/arc-testnet.json'));
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const port = Number(process.env.PORT ?? 8788);
// Loopback by default; containers set HOST=0.0.0.0 and publish the port deliberately.
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
guardPoolFaults(pool, line => console.error(line));
const store = new PostgresStore(pool, manifest.scope);
await store.migrate();
const primaryUrls = [process.env.ARC_RPC_URL ?? manifest.rpcUrl ?? 'http://127.0.0.1:8545',
  ...(process.env.ARC_RPC_FALLBACK_URLS ?? '').split(',').map(value => value.trim()).filter(Boolean)];
if (new Set(primaryUrls).size !== primaryUrls.length) throw new Error('Duplicate primary RPC endpoint');
const witnessUrl = process.env.ARC_WITNESS_RPC_URL;
// The witness must stay independent. Serving indexing traffic from it would
// turn its confirmation into self-agreement exactly when a provider is failing.
if (witnessUrl && primaryUrls.includes(witnessUrl)) throw new Error('Witness RPC must not also be a primary endpoint');
const clients = primaryUrls.map(url => createRpc(url, manifest.vaults, manifest.chainId));
const rpc = clients.length === 1 ? clients[0]! : createFailoverRpc(clients);
const witness = witnessUrl ? createRpc(witnessUrl, manifest.vaults, manifest.chainId) : undefined;
const indexer = new Indexer(rpc, store, manifest.fromBlock, {
  chainId: manifest.chainId, witness,
  batchSize: Number(process.env.INDEX_BATCH_SIZE ?? 100),
  concurrency: Number(process.env.INDEX_CONCURRENCY ?? 4),
});
const server = createApi(indexer, store, manifest.vaults.map(vault => vault.address), manifest.scope);
server.listen(port, host, () => console.log(`Saberent operator listening on http://${host}:${port}`));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true; server.close(); });
const faults = new FaultLog();
while (!stopping) {
  await indexer.tick();
  const line = faults.observe(indexer.state.error, Date.now());
  if (line) console.error(line);
  if (!stopping) await new Promise(resolve => setTimeout(resolve, indexer.state.error || indexer.state.lag === '0' ? 2_000 : 100));
}
await pool.end();
