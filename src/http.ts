import { createServer } from 'node:http';
import type { Indexer } from './indexer.ts';
import type { Store } from './types.ts';
import { json } from './types.ts';
import { CHECKPOINT_ALGORITHM, defaultCheckpointBlock, historyDigest } from './checkpoint.ts';

export function createApi(indexer: Indexer, store: Store, vaults: string[], scope?: string) {
  const allowed = new Set(vaults.map(address => address.toLowerCase()));
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: unknown) => { response.statusCode = status; response.end(json(body)); };
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); return send(405, { error: 'Only GET is supported' }); }
    if ((request.url?.length ?? 0) > 2048) return send(414, { error: 'URL too long' });
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') return send(indexer.healthy() ? 200 : 503, { healthy: indexer.healthy(), chainId: indexer.chainId, ...indexer.state });
      if (url.pathname === '/checkpoint') {
        // Committed history is final and ancestry-checked, so a catching-up operator can
        // still be compared below its indexed block; only a faulted operator is refused.
        if (indexer.state.error !== null) return send(503, { error: 'Indexer unavailable' });
        const snapshot = { ...indexer.state };
        if (snapshot.indexedBlock === null || snapshot.indexedBlockHash === null) return send(503, { error: 'No finalized checkpoint' });
        const indexed = BigInt(snapshot.indexedBlock);
        const rawBlock = url.searchParams.get('block');
        if (rawBlock !== null && !/^[0-9]{1,78}$/.test(rawBlock)) return send(400, { error: 'block must be a decimal block number' });
        const block = rawBlock === null ? defaultCheckpointBlock(indexed) : BigInt(rawBlock);
        if (block > indexed) return send(409, { error: 'block is above this operator\'s finalized index', indexedBlock: snapshot.indexedBlock });
        const digest = await historyDigest(store, [...allowed], block);
        if (indexer.state.error !== null) return send(503, { error: 'Indexer unavailable' });
        return send(200, { algorithm: CHECKPOINT_ALGORITHM, chainId: indexer.chainId, scope: scope ?? null, block: block.toString(), ...digest, indexedBlock: snapshot.indexedBlock, indexedBlockHash: snapshot.indexedBlockHash, caughtUp: indexer.healthy() });
      }
      const match = /^\/vaults\/(0x[0-9a-fA-F]{40})\/events$/.exec(url.pathname);
      if (!match?.[1] || !allowed.has(match[1].toLowerCase())) return send(404, { error: 'Unknown endpoint or vault' });
      const rawLimit = url.searchParams.get('limit') ?? '50';
      const rawCursor = url.searchParams.get('after');
      if (!/^[0-9]{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200) return send(400, { error: 'limit must be between 1 and 200' });
      if (rawCursor !== null && !/^[0-9]{1,78}:[0-9]{1,9}$/.test(rawCursor)) return send(400, { error: 'after must be blockNumber:logIndex' });
      // Stop serving history during disagreement; callers must not mistake a cache for settlement authority.
      if (!indexer.healthy()) return send(503, { error: 'Indexer unavailable or catching up' });
      const snapshot = { ...indexer.state };
      if (snapshot.indexedBlock === null || snapshot.indexedBlockHash === null) return send(503, { error: 'No finalized checkpoint' });
      const parts = rawCursor?.split(':');
      const after = parts ? { block: BigInt(parts[0]!), log: Number(parts[1]) } : null;
      const rows = await store.events(match[1].toLowerCase(), after, Number(rawLimit) + 1, BigInt(snapshot.indexedBlock));
      if (!indexer.healthy() || indexer.state.revision !== snapshot.revision || indexer.state.indexedBlock !== snapshot.indexedBlock || indexer.state.indexedBlockHash !== snapshot.indexedBlockHash) return send(503, { error: 'Index snapshot changed; retry' });
      const page = rows.slice(0, Number(rawLimit));
      const last = page.at(-1);
      send(200, { chainId: indexer.chainId, finality: 'rpc-finalized', indexedThrough: snapshot.indexedBlock, indexedBlockHash: snapshot.indexedBlockHash, events: page, nextCursor: rows.length > page.length && last ? `${last.blockNumber}:${last.logIndex}` : null });
    } catch { send(503, { error: 'History unavailable' }); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 30;
  return server;
}
