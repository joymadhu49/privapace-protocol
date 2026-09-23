// Compare history checkpoints from independent operators at one shared block.
// Usage: pnpm compare -- <operator-url> <operator-url> [...] [--block N]
// Exits 0 only if every operator reports the same scope, event count and digest.
const args = process.argv.slice(2).filter(arg => arg !== '--');
const blockIndex = args.indexOf('--block');
const requested = blockIndex >= 0 ? args.splice(blockIndex, 2)[1] : undefined;
if (requested !== undefined && !/^[0-9]{1,78}$/.test(requested)) throw new Error('--block must be a decimal block number');
const urls = args.map(value => new URL(value).toString().replace(/\/$/, ''));
if (urls.length < 2) { console.error('Provide at least two operator URLs'); process.exit(2); }

type Checkpoint = { algorithm: string; chainId: number; scope: string | null; block: string; eventCount: number; historySha256: string; indexedBlock: string };
async function checkpoint(base: string, block?: string): Promise<Checkpoint> {
  const response = await fetch(`${base}/checkpoint${block ? `?block=${block}` : ''}`, { signal: AbortSignal.timeout(60_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${base}: HTTP ${response.status} ${body.error ?? ''}`.trim());
  return body as Checkpoint;
}

// Default to the lowest shared default height so every operator can answer.
const heads = await Promise.all(urls.map(url => checkpoint(url)));
const block = requested ?? heads.map(head => BigInt(head.block)).reduce((a, b) => (a < b ? a : b)).toString();
const results = await Promise.allSettled(urls.map(url => checkpoint(url, block)));
const reference = results.find((result): result is PromiseFulfilledResult<Checkpoint> => result.status === 'fulfilled')?.value;
let agree = Boolean(reference);
console.log(`Block ${block}`);
results.forEach((result, index) => {
  if (result.status === 'rejected') { agree = false; console.log(`  ✗ ${urls[index]}  ${result.reason instanceof Error ? result.reason.message : result.reason}`); return; }
  const value = result.value;
  const same = value.algorithm === reference!.algorithm && value.chainId === reference!.chainId && value.scope === reference!.scope && value.eventCount === reference!.eventCount && value.historySha256 === reference!.historySha256;
  if (!same) agree = false;
  console.log(`  ${same ? '✓' : '✗'} ${urls[index]}  events=${value.eventCount} sha256=${value.historySha256.slice(0, 16)}… indexed=${value.indexedBlock}`);
});
console.log(agree ? 'All operators agree.' : 'Operators DISAGREE or are unavailable. Investigate before trusting any of them.');
process.exit(agree ? 0 : 1);
