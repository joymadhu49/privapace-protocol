export interface Block { number: bigint; hash: string; parentHash: string; timestamp: bigint }
export interface IndexedEvent {
  vault: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  eventName: string;
  args: unknown;
}
export interface Checkpoint { number: bigint; hash: string }
export interface Rpc {
  chainId(): Promise<number>;
  finalized(): Promise<Block>;
  block(number: bigint): Promise<Block>;
  events(block: Block): Promise<IndexedEvent[]>;
  eventsRange?(from: bigint, through: bigint): Promise<IndexedEvent[]>;
}
export interface Store {
  checkpoint(): Promise<Checkpoint | null>;
  commit(block: Block, expected: Checkpoint | null, events: IndexedEvent[]): Promise<void>;
  events(vault: string, after: { block: bigint; log: number } | null, limit: number, through: bigint): Promise<IndexedEvent[]>;
}
export const json = (value: unknown) => JSON.stringify(value, (_, item: unknown) => typeof item === 'bigint' ? item.toString() : item);

export class OperatorError extends Error {}
