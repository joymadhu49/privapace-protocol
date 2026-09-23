import { createPublicClient, decodeEventLog, http, toEventSelector, type AbiEvent, type Hash } from 'viem';
import { OperatorError } from './types.ts';
import { validateRpcUrl, type VaultConfig } from './config.ts';
import type { Block, IndexedEvent, Rpc } from './types.ts';

const supported = new Set(['Deposit', 'Withdrawal', 'PendingRolled', 'ConfidentialTransfer']);
export function createRpc(url: string, vaults: VaultConfig[], chainId = 5042002): Rpc {
  const endpoint = validateRpcUrl(url, chainId);
  const client = createPublicClient({ transport: http(endpoint, { timeout: 15_000, retryCount: 1, fetchOptions: { redirect: 'error' } }) });
  const block = (value: Awaited<ReturnType<typeof client.getBlock>>): Block => {
    if (value.number === null || !value.hash) throw new OperatorError('RPC returned an unmined block');
    return { number: value.number, hash: value.hash, parentHash: value.parentHash, timestamp: value.timestamp };
  };
  return {
    chainId: () => client.getChainId(),
    finalized: async () => block(await client.getBlock({ blockTag: 'finalized' })),
    block: async number => block(await client.getBlock({ blockNumber: number })),
    async eventsRange(from, through) {
      if (from < 0n || through < from || through - from >= 500n) throw new OperatorError('Invalid log query range');
      const events: IndexedEvent[] = [];
      const identities = new Set<string>();
      for (const vault of vaults) {
        const start = vault.fromBlock !== undefined && vault.fromBlock > from ? vault.fromBlock : from;
        if (start > through) continue;
        const abi = vault.abi.filter((item): item is AbiEvent => item.type === 'event' && supported.has(item.name));
        const selectors = new Set(abi.map(event => toEventSelector(event)));
        const logs = await client.getLogs({ address: vault.address, fromBlock: start, toBlock: through });
        for (const log of logs) {
          if (!log.topics[0] || !selectors.has(log.topics[0])) continue;
          if (log.removed || !log.blockHash || log.blockNumber === null || log.blockNumber < start || log.blockNumber > through || log.logIndex === null || !log.transactionHash || log.address.toLowerCase() !== vault.address.toLowerCase()) throw new OperatorError('RPC returned inconsistent event identity');
          const identity = `${log.blockNumber}:${log.logIndex}`;
          if (identities.has(identity)) throw new OperatorError('RPC returned duplicate event identity');
          identities.add(identity);
          const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
          events.push({ vault: vault.address, blockNumber: log.blockNumber.toString(), blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex, eventName: decoded.eventName, args: decoded.args });
        }
      }
      return events.sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.logIndex - b.logIndex);
    },
    async events(at) {
      const events: IndexedEvent[] = [];
      for (const vault of vaults) {
        if (vault.fromBlock !== undefined && at.number < vault.fromBlock) continue;
        const abi = vault.abi.filter((item): item is AbiEvent => item.type === 'event' && supported.has(item.name));
        const selectors = new Set(abi.map(event => toEventSelector(event)));
        const logs = await client.getLogs({ address: vault.address, blockHash: at.hash as Hash });
        for (const log of logs) {
          if (!log.topics[0] || !selectors.has(log.topics[0])) continue;
          if (log.removed || log.blockHash !== at.hash || log.blockNumber !== at.number || log.logIndex === null || !log.transactionHash || log.address.toLowerCase() !== vault.address.toLowerCase()) throw new OperatorError('RPC returned inconsistent event identity');
          const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
          events.push({ vault: vault.address, blockNumber: at.number.toString(), blockHash: at.hash, transactionHash: log.transactionHash, logIndex: log.logIndex, eventName: decoded.eventName, args: decoded.args });
        }
      }
      return events.sort((a, b) => a.logIndex - b.logIndex);
    },
  };
}
