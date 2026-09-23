import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isAddress, type Abi, type Address } from 'viem';

export interface VaultConfig { address: Address; abi: Abi; fromBlock?: bigint }
export interface Manifest { chainId: number; fromBlock: bigint; vaults: VaultConfig[]; scope: string; rpcUrl?: string }
export function validateRpcUrl(value: string, chainId: number): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RPC must use HTTP(S)');
  if (chainId !== 31337 && chainId !== 5042002) throw new Error('Unsupported chain');
  if (chainId === 31337 && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('Local development RPC must use a loopback address');
  return url.toString();
}
export async function readManifest(path: string): Promise<Manifest> {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  if (raw.chainId !== 5042002 && !(raw.chainId === 31337 && raw.network === 'local' && raw.devOnly === true)) throw new Error('Only Arc testnet or explicit local development is supported');
  const rpcUrl = raw.rpcUrl === undefined ? undefined : validateRpcUrl(raw.rpcUrl, raw.chainId);
  if (raw.chainId === 31337 && !rpcUrl) throw new Error('Local manifest requires an explicit loopback rpcUrl');
  if (typeof raw.fromBlock !== 'string' || !/^[0-9]{1,78}$/.test(raw.fromBlock)) throw new Error('fromBlock must be a decimal string');
  if (!Array.isArray(raw.vaults) || !raw.vaults.length || raw.vaults.length > 100) throw new Error('Manifest requires 1–100 vaults');
  const vaults: VaultConfig[] = [];
  for (const entry of raw.vaults) {
    if (!isAddress(entry.address) || /^0x0{40}$/i.test(entry.address)) throw new Error('Invalid vault address');
    const artifact = entry.abi ?? JSON.parse(await readFile(resolve(dirname(path), String(entry.abiPath)), 'utf8'));
    const abi = Array.isArray(artifact) ? artifact : artifact.abi;
    if (!Array.isArray(abi)) throw new Error('Vault ABI is missing');
    for (const name of ['Deposit', 'Withdrawal', 'PendingRolled', 'ConfidentialTransfer']) {
      if (!abi.some(item => item.type === 'event' && item.name === name)) throw new Error(`Vault ABI missing event ${name}`);
    }
    const start = entry.fromBlock ?? raw.fromBlock;
    if (typeof start !== 'string' || !/^[0-9]{1,78}$/.test(start) || BigInt(start) < BigInt(raw.fromBlock)) throw new Error('Invalid vault deployment block');
    vaults.push({ address: entry.address.toLowerCase(), abi, fromBlock: BigInt(start) });
  }
  if (new Set(vaults.map(vault => vault.address)).size !== vaults.length) throw new Error('Duplicate vault address');
  const scope = createHash('sha256').update(JSON.stringify({ chainId: raw.chainId, fromBlock: raw.fromBlock, vaults }, (_, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex');
  return { chainId: raw.chainId, fromBlock: BigInt(raw.fromBlock), vaults, scope, rpcUrl };
}
