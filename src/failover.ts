import { OperatorError } from './types.ts';
import type { Block, IndexedEvent, Rpc } from './types.ts';

/** Availability failover across equally trusted primary endpoints.
 *
 *  Only transport failures advance the endpoint. An OperatorError means a
 *  provider answered with inconsistent data; retrying that elsewhere would let
 *  the indexer shop for an endpoint that agrees, hiding a fork or a corrupt
 *  provider, so those always fail closed on the endpoint that produced them.
 *
 *  Selection is sticky: a working endpoint keeps serving until it fails, and
 *  the preferred endpoint is retried only after a cooldown. This never relaxes
 *  a witness check; the witness stays a separate, independent client. */
export function createFailoverRpc(endpoints: Rpc[], options: { now?: () => number; recoverAfterMs?: number } = {}): Rpc {
  if (!Array.isArray(endpoints) || endpoints.length === 0) throw new Error('Failover RPC requires at least one endpoint');
  const recoverAfterMs = options.recoverAfterMs ?? 300_000;
  if (!Number.isInteger(recoverAfterMs) || recoverAfterMs < 0) throw new Error('Invalid failover recovery interval');
  const now = () => options.now?.() ?? Date.now();
  let current = 0;
  let demotedAt = 0;

  // Preferred endpoint first once the cooldown has elapsed, then the rest in
  // declaration order. Every endpoint is attempted at most once per call.
  const order = () => {
    const start = current !== 0 && now() - demotedAt >= recoverAfterMs ? 0 : current;
    const sequence = [start];
    for (let offset = 1; offset < endpoints.length; offset++) sequence.push((start + offset) % endpoints.length);
    return sequence;
  };

  const run = async <T>(call: (rpc: Rpc) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const index of order()) {
      try {
        const value = await call(endpoints[index]!);
        if (index !== current) {
          if (index !== 0) demotedAt = now();
          current = index;
        }
        return value;
      } catch (error) {
        // Inconsistent data is a correctness signal, never an availability one.
        if (error instanceof OperatorError) throw error;
        last = error;
        if (index === current) demotedAt = now();
      }
    }
    throw last;
  };

  const rpc: Rpc = {
    chainId: () => run(endpoint => endpoint.chainId()),
    finalized: () => run(endpoint => endpoint.finalized()),
    block: (number: bigint) => run(endpoint => endpoint.block(number)),
    events: (at: Block) => run(endpoint => endpoint.events(at)),
  };
  // Only expose the bounded range query when every endpoint implements it;
  // silently degrading to per-block reads mid-failover would change the
  // indexer's request shape without any operator-visible signal.
  if (endpoints.every(endpoint => typeof endpoint.eventsRange === 'function')) {
    rpc.eventsRange = (from: bigint, through: bigint): Promise<IndexedEvent[]> =>
      run(endpoint => endpoint.eventsRange!(from, through));
  }
  return rpc;
}
