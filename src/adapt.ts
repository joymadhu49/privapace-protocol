import { isAddress, type Abi } from 'viem';
import { validateRpcUrl } from './config.ts';

/** Convert the website/deployer manifest without discarding its provenance metadata. */
export function adaptDeployment(input: unknown, abi: Abi) {
  const d = input as Record<string, unknown>;
  if (!d || d.schemaVersion !== 2 || d.devOnly !== true || !Array.isArray(d.vaults) || d.vaults.length < 1 || d.vaults.length > 100) throw new Error('Expected a configured development deployment manifest');
  if (!(d.chainId === 31337 && d.network === 'local') && !(d.chainId === 5042002 && d.network === 'testnet')) throw new Error('Unsupported deployment network');
  const rpcUrl = validateRpcUrl(String(d.rpcUrl), d.chainId as number);
  const address = (value: unknown) => typeof value === 'string' && isAddress(value) && !/^0x0{40}$/i.test(value);
  const verifiers = d.verifiers as Record<string, unknown> | undefined;
  if (!address(d.registry) || !address(d.factory) || !verifiers || !['transfer', 'withdraw', 'register'].every(name => address(verifiers[name]))) throw new Error('Missing deployment registry, factory or verifier addresses');
  const vaults = d.vaults.map((vault: Record<string, unknown>) => {
    if (!address(vault.address) || vault.verifierVersion !== 2 || typeof vault.fromBlock !== 'string' || !/^[0-9]{1,78}$/.test(vault.fromBlock)) throw new Error('Invalid deployed vault metadata');
    return { ...vault, fromBlock: vault.fromBlock, abi };
  });
  const earliest = vaults.reduce((minimum, vault) => BigInt(vault.fromBlock) < minimum ? BigInt(vault.fromBlock) : minimum, BigInt(vaults[0]!.fromBlock));
  return { ...d, registry: d.registry, factory: d.factory, verifiers, rpcUrl, fromBlock: earliest.toString(), vaults };
}
