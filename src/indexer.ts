import { OperatorError } from './types.ts';
import type { Block, Checkpoint, Rpc, Store } from './types.ts';

export class Indexer {
  readonly state = { revision: 0, lastSuccessAt: 0, finalizedBlock: '0', indexedBlock: null as string | null, indexedBlockHash: null as string | null, lag: '0', error: 'starting' as string | null };
  private checking = false;
  constructor(
    private readonly rpc: Rpc,
    private readonly store: Store,
    private readonly fromBlock: bigint,
    private readonly options: { chainId?: number; batchSize?: number; concurrency?: number; staleMs?: number; witness?: Rpc; now?: () => number } = {},
  ) {
    for (const [value, maximum] of [[options.batchSize ?? 25, 500], [options.concurrency ?? 4, 16]]) {
      if (!Number.isInteger(value) || value! < 1 || value! > maximum!) throw new Error('Invalid indexing batch size or concurrency');
    }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  get chainId() { return this.options.chainId ?? 5042002; }
  healthy() { return !this.checking && this.state.error === null && this.now() - this.state.lastSuccessAt < (this.options.staleMs ?? 120_000) && this.state.lag === '0'; }
  private async verify(block: Block) {
    if (this.options.witness) {
      const observed = await this.options.witness.block(block.number);
      if (observed.hash !== block.hash) throw new OperatorError(`RPC disagreement at block ${block.number}`);
    }
  }
  async tick() {
    if (this.checking) return;
    this.checking = true;
    this.state.revision++;
    try {
      const chain = this.options.chainId ?? 5042002;
      if (await this.rpc.chainId() !== chain) throw new OperatorError('RPC chain ID mismatch');
      if (this.options.witness && await this.options.witness.chainId() !== chain) throw new OperatorError('Witness chain ID mismatch');
      const final = await this.rpc.finalized();
      if (final.number < this.fromBlock) throw new OperatorError('Manifest start block has not finalized');
      const age = this.now() - Number(final.timestamp) * 1_000;
      if (age > (this.options.staleMs ?? 120_000) || age < -30_000) throw new OperatorError('RPC finalized head is stale or future-dated');
      await this.verify(final);
      if (this.options.witness && (await this.options.witness.finalized()).number < final.number) throw new OperatorError('Witness has not finalized primary head');
      let checkpoint = await this.store.checkpoint();
      if (checkpoint) {
        if (final.number < checkpoint.number) throw new OperatorError('RPC finalized head regressed');
        const saved = await this.rpc.block(checkpoint.number);
        if (saved.hash !== checkpoint.hash) throw new OperatorError('Finalized checkpoint hash changed; manual reconciliation required');
        await this.verify(saved);
      }
      this.state.finalizedBlock = final.number.toString();
      const start = checkpoint ? checkpoint.number + 1n : this.fromBlock;
      const end = start + BigInt(this.options.batchSize ?? 25) - 1n;
      const through = end < final.number ? end : final.number;
      const concurrency = this.options.concurrency ?? 4;
      const rangeEvents = this.rpc.eventsRange && start <= through ? await this.rpc.eventsRange(start, through) : undefined;
      const byBlock = new Map<string, typeof rangeEvents>();
      for (const event of rangeEvents ?? []) {
        if (!/^[0-9]+$/.test(event.blockNumber) || BigInt(event.blockNumber) < start || BigInt(event.blockNumber) > through) throw new OperatorError('Event outside requested block range');
        const rows = byBlock.get(event.blockNumber) ?? [];
        rows.push(event);
        byBlock.set(event.blockNumber, rows);
      }
      for (let next = start; next <= through; next += BigInt(concurrency)) {
        const heights = Array.from({ length: Number(through - next + 1n < BigInt(concurrency) ? through - next + 1n : BigInt(concurrency)) }, (_, offset) => next + BigInt(offset));
        // Fetch a bounded window concurrently, but validate ancestry and commit in order.
        // Settling every request prevents a later failure from leaking an unhandled rejection.
        const results = await Promise.allSettled(heights.map(async height => {
          const block = await this.rpc.block(height);
          if (block.number !== height) throw new OperatorError('RPC returned wrong block height');
          if (height === final.number && block.hash !== final.hash) throw new OperatorError('Finalized head changed during indexing');
          await this.verify(block);
          const events = rangeEvents ? byBlock.get(height.toString()) ?? [] : await this.rpc.events(block);
          if (events.some(event => event.blockHash !== block.hash || event.blockNumber !== height.toString())) throw new OperatorError('Event block identity mismatch');
          // Re-read after logs: a changing provider must never advance the checkpoint.
          if ((await this.rpc.block(height)).hash !== block.hash) throw new OperatorError('Block changed while reading events');
          await this.verify(block);
          return { block, events };
        }));
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason;
          const { block, events } = result.value;
          if (checkpoint && block.parentHash !== checkpoint.hash) throw new OperatorError('Block parent does not match finalized checkpoint');
          await this.store.commit(block, checkpoint, events);
          checkpoint = { number: block.number, hash: block.hash } satisfies Checkpoint;
        }
      }
      this.state.indexedBlock = checkpoint?.number.toString() ?? null;
      this.state.indexedBlockHash = checkpoint?.hash ?? null;
      this.state.lag = (checkpoint ? final.number - checkpoint.number : final.number >= this.fromBlock ? final.number - this.fromBlock + 1n : 0n).toString();
      this.state.lastSuccessAt = this.now();
      this.state.error = null;
    } catch (error) {
      this.state.error = error instanceof OperatorError ? error.message : 'RPC or database operation failed; check connectivity and configuration';
    } finally {
      this.checking = false;
      this.state.revision++;
    }
  }
}
