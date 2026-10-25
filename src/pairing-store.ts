import type { Database } from './types.js';

export interface PairingContext { scope: string; ownerId: string }
export interface PairingWindow {
  ref: string; status: 'open' | 'pending' | 'confirmed' | 'cancelled' | 'expired';
  expiresAt: Date; candidateAt: Date | null;
}
export interface PairedTester { ref: string; approvedAt: Date }
export interface PairingStatus { window: PairingWindow | null; testers: PairedTester[] }

type WindowRow = {
  ref: string; status: PairingWindow['status']; expires_at: Date | string;
  candidate_at: Date | string | null; candidate_user_id?: string | null;
};
const windowFrom = (row: WindowRow): PairingWindow => ({
  ref: row.ref, status: row.status, expiresAt: new Date(row.expires_at),
  candidateAt: row.candidate_at === null ? null : new Date(row.candidate_at),
});
const isHash = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);
const publicWindowColumns = 'ref, status, expires_at, candidate_at';

export class PairingStore {
  constructor(private readonly db: Database) {}

  private async inContext<T>(context: PairingContext, fn: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      // A database lock also serializes separate processes and survives restarts.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([context.scope, context.ownerId])]);
      await tx.query(`UPDATE pairing_windows SET status = 'expired', code_hash = NULL,
        candidate_user_id = NULL, candidate_at = NULL, closed_at = expires_at
        WHERE scope = $1 AND owner_id = $2 AND status IN ('open', 'pending') AND expires_at <= clock_timestamp()`,
      [context.scope, context.ownerId]);
      return fn(tx);
    });
  }

  async open(context: PairingContext, eventId: string, codeHash: string): Promise<PairingWindow> {
    if (!isHash(codeHash)) throw new Error('Pairing code must be a SHA-256 hash');
    return this.inContext(context, async tx => {
      const existing = await tx.query<WindowRow>(`SELECT ${publicWindowColumns} FROM pairing_windows
        WHERE scope = $1 AND owner_id = $2 AND source_event_id = $3`, [context.scope, context.ownerId, eventId]);
      if (existing.rows[0]) return windowFrom(existing.rows[0]);
      await tx.query(`UPDATE pairing_windows SET status = 'cancelled', code_hash = NULL,
        candidate_user_id = NULL, candidate_at = NULL, closed_at = clock_timestamp()
        WHERE scope = $1 AND owner_id = $2 AND status IN ('open', 'pending')`, [context.scope, context.ownerId]);
      const result = await tx.query<WindowRow>(`INSERT INTO pairing_windows (scope, owner_id, source_event_id, code_hash)
        VALUES ($1, $2, $3, $4) RETURNING ${publicWindowColumns}`, [context.scope, context.ownerId, eventId, codeHash]);
      return windowFrom(result.rows[0]!);
    });
  }

  async capture(context: PairingContext, eventId: string, userId: string, codeHash: string): Promise<boolean> {
    return this.inContext(context, async tx => {
      if (userId === context.ownerId || !isHash(codeHash)) return false;
      const result = await tx.query(`UPDATE pairing_windows SET status = 'pending', code_hash = NULL,
        candidate_user_id = $3, candidate_event_id = $4, candidate_at = clock_timestamp()
        WHERE scope = $1 AND owner_id = $2 AND status = 'open' AND expires_at > clock_timestamp() AND code_hash = $5
          AND NOT EXISTS (SELECT 1 FROM pairing_windows previous
            WHERE previous.scope = $1 AND previous.owner_id = $2 AND previous.candidate_event_id = $4)
        RETURNING ref`, [context.scope, context.ownerId, userId, eventId, codeHash]);
      return result.rows.length === 1;
    });
  }

  async status(context: PairingContext): Promise<PairingStatus> {
    return this.inContext(context, async tx => {
      const window = await tx.query<WindowRow>(`SELECT ${publicWindowColumns} FROM pairing_windows
        WHERE scope = $1 AND owner_id = $2 AND status IN ('open', 'pending')`, [context.scope, context.ownerId]);
      const testers = await tx.query<{ ref: string; approved_at: Date | string }>(`SELECT ref, approved_at FROM tester_grants
        WHERE scope = $1 AND owner_id = $2 AND user_id <> owner_id ORDER BY approved_at, ref`, [context.scope, context.ownerId]);
      return {
        window: window.rows[0] ? windowFrom(window.rows[0]) : null,
        testers: testers.rows.map(row => ({ ref: row.ref, approvedAt: new Date(row.approved_at) })),
      };
    });
  }

  async confirm(context: PairingContext, ref: string): Promise<boolean> {
    return this.inContext(context, async tx => {
      // Grants deliberately outlive window metadata. Only the exact live grant
      // permits a retry, so a removed grant cannot be recreated by confirmation.
      const granted = await tx.query(`SELECT ref FROM tester_grants WHERE scope = $1 AND owner_id = $2
        AND ref = $3 AND user_id <> owner_id`, [context.scope, context.ownerId, ref]);
      if (granted.rows.length) return true;
      const result = await tx.query<WindowRow>(`SELECT ${publicWindowColumns}, candidate_user_id FROM pairing_windows
        WHERE scope = $1 AND owner_id = $2 AND ref = $3 AND status = 'pending'
          AND expires_at > clock_timestamp() AND candidate_user_id <> owner_id FOR UPDATE`, [context.scope, context.ownerId, ref]);
      const window = result.rows[0];
      if (!window?.candidate_user_id) return false;
      await tx.query(`INSERT INTO tester_grants (scope, owner_id, user_id, ref) VALUES ($1, $2, $3, $4)
        ON CONFLICT (scope, owner_id, user_id) DO UPDATE SET ref = EXCLUDED.ref, approved_at = clock_timestamp()`,
      [context.scope, context.ownerId, window.candidate_user_id, ref]);
      await tx.query(`UPDATE pairing_windows SET status = 'confirmed', code_hash = NULL,
        candidate_user_id = NULL, candidate_at = NULL, closed_at = clock_timestamp()
        WHERE scope = $1 AND owner_id = $2 AND ref = $3`, [context.scope, context.ownerId, ref]);
      return true;
    });
  }

  async cancel(context: PairingContext): Promise<boolean> {
    return this.inContext(context, async tx => {
      const result = await tx.query(`UPDATE pairing_windows SET status = 'cancelled', code_hash = NULL,
        candidate_user_id = NULL, candidate_at = NULL, closed_at = clock_timestamp()
        WHERE scope = $1 AND owner_id = $2 AND status IN ('open', 'pending') RETURNING ref`, [context.scope, context.ownerId]);
      return result.rows.length === 1;
    });
  }

  async remove(context: PairingContext, ref: string): Promise<boolean> {
    return this.inContext(context, async tx => {
      const granted = await tx.query<{ user_id: string }>(`SELECT user_id FROM tester_grants
        WHERE scope = $1 AND owner_id = $2 AND ref = $3 FOR UPDATE`, [context.scope, context.ownerId, ref]);
      const userId = granted.rows[0]?.user_id;
      if (!userId) return false;
      // Share the normal send-intent/session lock before fencing queued replies.
      await tx.query('SELECT user_id FROM sessions WHERE user_id = $1 FOR UPDATE', [userId]);
      await tx.query(`UPDATE events SET manual_handoff = true WHERE user_id = $1 AND status IN ('pending', 'processing')`, [userId]);
      await tx.query('DELETE FROM tester_grants WHERE scope = $1 AND owner_id = $2 AND ref = $3', [context.scope, context.ownerId, ref]);
      return true;
    });
  }

  async isTester(context: PairingContext, userId: string): Promise<boolean> {
    if (userId === context.ownerId) return false;
    const result = await this.db.query(`SELECT ref FROM tester_grants WHERE scope = $1 AND owner_id = $2
      AND user_id = $3 AND user_id <> owner_id`, [context.scope, context.ownerId, userId]);
    return result.rows.length === 1;
  }

  async cleanup(): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.query(`UPDATE pairing_windows SET status = 'expired', code_hash = NULL,
        candidate_user_id = NULL, candidate_at = NULL, closed_at = expires_at
        WHERE status IN ('open', 'pending') AND expires_at <= clock_timestamp()`);
      await tx.query(`DELETE FROM pairing_windows WHERE status IN ('confirmed', 'cancelled', 'expired')
        AND closed_at <= clock_timestamp() - interval '24 hours'`);
    });
  }
}
