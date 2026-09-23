import pg from 'pg';
import type { Block, Checkpoint, IndexedEvent, Store } from './types.ts';
import { json } from './types.ts';

export class PostgresStore implements Store {
  constructor(private readonly pool: pg.Pool, private readonly scope: string) {}
  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS saberent_checkpoints (
        scope text PRIMARY KEY, block_number numeric(78,0), block_hash text,
        CHECK ((block_number IS NULL) = (block_hash IS NULL))
      );
      CREATE TABLE IF NOT EXISTS saberent_events (
        scope text NOT NULL, vault text NOT NULL, block_number numeric(78,0) NOT NULL,
        block_hash text NOT NULL, transaction_hash text NOT NULL, log_index integer NOT NULL,
        event_name text NOT NULL, args jsonb NOT NULL,
        PRIMARY KEY (scope, block_number, log_index)
      );
      CREATE INDEX IF NOT EXISTS saberent_events_vault_page
        ON saberent_events(scope, vault, block_number, log_index);
    `);
    await this.pool.query('INSERT INTO saberent_checkpoints(scope) VALUES ($1) ON CONFLICT DO NOTHING', [this.scope]);
  }
  async checkpoint(): Promise<Checkpoint | null> {
    const result = await this.pool.query('SELECT block_number, block_hash FROM saberent_checkpoints WHERE scope=$1', [this.scope]);
    const row = result.rows[0];
    return row?.block_number == null ? null : { number: BigInt(row.block_number), hash: row.block_hash };
  }
  async commit(block: Block, expected: Checkpoint | null, events: IndexedEvent[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT block_number, block_hash FROM saberent_checkpoints WHERE scope=$1 FOR UPDATE', [this.scope]);
      const row = result.rows[0];
      if (!row) throw new Error('Checkpoint scope missing; run migration');
      // Two processes cannot both advance from the same cursor.
      if ((row.block_number == null ? null : String(row.block_number)) !== (expected?.number.toString() ?? null) || (row.block_hash ?? null) !== (expected?.hash ?? null)) throw new Error('Concurrent checkpoint update; retry');
      for (const event of events) {
        await client.query('INSERT INTO saberent_events(scope,vault,block_number,block_hash,transaction_hash,log_index,event_name,args) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [this.scope, event.vault.toLowerCase(), event.blockNumber, event.blockHash, event.transactionHash, event.logIndex, event.eventName, json(event.args)]);
      }
      await client.query('UPDATE saberent_checkpoints SET block_number=$2, block_hash=$3 WHERE scope=$1', [this.scope, block.number.toString(), block.hash]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async events(vault: string, after: { block: bigint; log: number } | null, limit: number, through: bigint): Promise<IndexedEvent[]> {
    const result = await this.pool.query(`SELECT vault, block_number, block_hash, transaction_hash, log_index, event_name, args
      FROM saberent_events WHERE scope=$1 AND vault=$2 AND block_number <= $6::numeric
      AND (block_number > $3::numeric OR (block_number = $3::numeric AND log_index > $4))
      ORDER BY block_number, log_index LIMIT $5`, [this.scope, vault.toLowerCase(), after?.block.toString() ?? '-1', after?.log ?? -1, limit, through.toString()]);
    return result.rows.map(row => ({ vault: row.vault, blockNumber: row.block_number, blockHash: row.block_hash, transactionHash: row.transaction_hash, logIndex: row.log_index, eventName: row.event_name, args: row.args }));
  }
}
