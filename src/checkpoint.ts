import { createHash } from 'node:crypto';
import type { IndexedEvent, Store } from './types.ts';

// Independent operators compare this digest at the same block to prove they indexed
// identical history. Bump the algorithm name if the encoding below ever changes.
export const CHECKPOINT_ALGORITHM = 'privapace-history-v1';
// Default comparison height, so operators at slightly different heights still meet.
export const CHECKPOINT_INTERVAL = 1000n;

// JSON with recursively sorted keys: storage (jsonb) and RPC decoding order keys differently.
export function canonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function eventLine(event: IndexedEvent): string {
  return canonical([event.vault.toLowerCase(), event.blockNumber, event.logIndex, event.blockHash.toLowerCase(), event.transactionHash.toLowerCase(), event.eventName, event.args]);
}

export function defaultCheckpointBlock(indexedBlock: bigint): bigint {
  return indexedBlock - (indexedBlock % CHECKPOINT_INTERVAL);
}

export async function historyDigest(store: Store, vaults: string[], through: bigint, pageSize = 500) {
  const hash = createHash('sha256');
  let eventCount = 0;
  for (const vault of [...new Set(vaults.map(address => address.toLowerCase()))].sort()) {
    let after: { block: bigint; log: number } | null = null;
    for (;;) {
      const page = await store.events(vault, after, pageSize, through);
      for (const event of page) { hash.update(eventLine(event)); hash.update('\n'); }
      eventCount += page.length;
      const last = page.at(-1);
      if (page.length < pageSize || !last) break;
      after = { block: BigInt(last.blockNumber), log: last.logIndex };
    }
  }
  return { eventCount, historySha256: hash.digest('hex') };
}
