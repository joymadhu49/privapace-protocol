# PrivaPace operator

Run an independent, read-only operator for [PrivaPace](https://privapace.xyz)
on Arc Testnet, and verify PrivaPace's history and contracts yourself.

> **Status: Arc Testnet development release.** Test tokens only. PrivaPace's
> contracts and proof setup have not had an independent audit.

## What an operator is, and is not

| It does | It does not |
|---|---|
| Read finalized Arc blocks and PrivaPace vault events from an RPC provider | Hold spending keys or viewing keys |
| Check each block's parent hash against the previous block | Send transactions or approve transfers |
| Optionally cross-check every block with a second, independent RPC provider (a *witness*) | Vote on blocks. It is **not an Arc validator**; Arc's validators are authorized by Arc |
| Stop and report an error when providers disagree | Earn rewards. There is no token and no staking |
| Publish a **checkpoint**: a hash of all indexed history up to a block | Decide what is true on its own. Compare several operators |

## Requirements

- Docker with Compose, or Node.js 22+, pnpm and PostgreSQL 16.
- 2 CPU cores, 2 GB RAM, 5 GB disk.
- An Arc Testnet RPC endpoint. The public `https://rpc.testnet.arc.io` works; a
  second provider for the witness is strongly recommended.
- Time for the first sync. The operator verifies every block since the vault was
  created (62,731,897). On public RPC this measured about **6 blocks per second,
  roughly 1–2 days**, limited by provider rate limits. A private RPC is faster.

## Run with Docker

```sh
git clone https://github.com/joymadhu49/privapace-protocol.git
cd privapace-protocol
cp operator.env.example operator.env       # review; add a witness RPC if you have one
openssl rand -hex 24 > db_password.txt     # stays on your machine
chmod 600 operator.env db_password.txt
docker compose up -d --build
curl -s http://127.0.0.1:8788/health
```

`indexedBlock` rises until `lag` is `0` and `healthy` is `true`. While it catches
up, `healthy: false` is expected. A non-null `error` is a real problem; read
`docker compose logs operator`.

## Run without Docker

```sh
pnpm install --frozen-lockfile
export DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DB
export SABERENT_MANIFEST=$PWD/deployments/testnet.operator.json
export ARC_RPC_URL=https://rpc.testnet.arc.io
pnpm start
```

All settings are documented in [.env.example](.env.example).

## Checkpoints

```sh
curl -s http://127.0.0.1:8788/checkpoint
```

```json
{
  "algorithm": "privapace-history-v1",
  "chainId": 5042002,
  "scope": "1d476532b385c493a45d85e5f5ca67aa97cbb0d7c38c32e75e7044dbd27cba02",
  "block": "62737000",
  "eventCount": 8,
  "historySha256": "84d3bb9e8f1f50697fbaa22660038bf7d0ce1b82a64b47e0cca5e5cde46d0384",
  "indexedBlock": "62737164",
  "caughtUp": false
}
```

- `scope` identifies the chain, vault and ABI you index. It must equal
  `operator.scope` in [contracts.json](contracts.json).
- `historySha256` is a SHA-256 over every indexed vault event up to `block`, in
  chain order, with the canonical encoding in [src/checkpoint.ts](src/checkpoint.ts).
- Without `?block=`, the operator uses its indexed height rounded down to a
  multiple of 1,000, so operators at slightly different heights meet at the same
  block. A catching-up operator already answers for blocks it has indexed.

The values above are real: two independently synced operators returned exactly
this digest at block 62,737,000.

## Compare operators

```sh
pnpm compare -- https://operator-a.example https://operator-b.example
```

Exits `0` only if scope, event count and digest all match; otherwise it shows
which operator differs and exits `1`. A mismatch means at least one operator
reads from a wrong or inconsistent provider. Trust none of them until you know
which.

To let others compare with you, expose only `/health` and `/checkpoint` through
a reverse proxy or tunnel you control.

## Verify the contracts

[contracts.json](contracts.json) (also at <https://privapace.xyz/contracts.json>)
lists every official PrivaPace contract with its explorer link, its Sourcify
exact-match source and the SHA-256 of its deployed runtime bytecode. Recheck one:

```sh
curl -s -X POST https://rpc.testnet.arc.io -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x26e632294D526CF2C036C8427E3d1a21928D3ccA","finalized"]}' \
  | python3 -c 'import json,sys,hashlib;print(hashlib.sha256(bytes.fromhex(json.load(sys.stdin)["result"][2:])).hexdigest())'
```

The output must equal that contract's `runtimeBytecodeSha256`.

## Tests

```sh
pnpm test
pnpm typecheck
```

## Contact

Questions, operator problems and checkpoint mismatches: open a GitHub issue.
Security reports: see [SECURITY.md](SECURITY.md).
