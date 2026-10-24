import { randomUUID } from 'node:crypto';
import { formatNotification } from './notifications.js';
import type { Database, EventJob, LineEvent, NotificationJob, Outcome, Session, Task } from './types.js';

const REDACTED = '[已依保存期限移除]';
type EventRow = {
  id: string; user_id: string; customer_ref: string; payload: LineEvent | null;
  received_at: Date | string; attempts: number; lease_token: string;
  send_started: Date | null; text_removed_at: Date | null;
  expired?: boolean;
};
type SessionRow = { user_id: string; customer_ref: string; handoff: boolean };
type TaskRow = {
  id: string; customer_ref: string; status: string; booking_status: string;
  summary: string; next_action: string; service: string | null; requested_time: string | null; received_at: Date | string;
};
const sessionFrom = (row: SessionRow): Session => ({ userId: row.user_id, customerRef: row.customer_ref, handoff: row.handoff });
const taskFrom = (row: TaskRow): Task => ({
  id: row.id, customerRef: row.customer_ref, status: row.status, bookingStatus: row.booking_status,
  summary: row.summary, nextAction: row.next_action, service: row.service,
  requestedTime: row.requested_time, receivedAt: new Date(row.received_at),
});

export class Store {
  constructor(private readonly db: Database) {}

  async ping(): Promise<void> { await this.db.query('SELECT 1'); }

  async ingest(events: LineEvent[]): Promise<void> {
    await this.db.transaction(async tx => {
      // Serialize each customer's insertion sequence before any event INSERT.
      // A single claim statement's MVCC snapshot otherwise can hide an earlier
      // uncommitted insertion even if that transaction commits before row locks.
      const users = [...new Set(events.map(event => event.source.userId).filter((id): id is string => !!id))].sort();
      for (const userId of users) {
        await tx.query('INSERT INTO sessions (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
        await tx.query('SELECT user_id FROM sessions WHERE user_id = $1 FOR UPDATE', [userId]);
      }
      for (const event of events) {
        const userId = event.source.userId;
        if (!userId) continue;
        await tx.query(`INSERT INTO events (id, user_id, payload, received_at) VALUES ($1, $2, $3::jsonb, $4)
          ON CONFLICT (id) DO NOTHING`, [event.webhookEventId, userId, JSON.stringify(event), new Date(event.timestamp)]);
      }
    });
  }

  async getSession(userId: string): Promise<Session> {
    return this.db.transaction(async tx => {
      await tx.query('INSERT INTO sessions (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
      const result = await tx.query<SessionRow>('SELECT user_id, customer_ref, handoff FROM sessions WHERE user_id = $1', [userId]);
      return sessionFrom(result.rows[0]!);
    });
  }

  async sessionForRef(ref: string): Promise<Session | null> {
    const result = await this.db.query<SessionRow>('SELECT user_id, customer_ref, handoff FROM sessions WHERE customer_ref = $1', [ref]);
    return result.rows[0] ? sessionFrom(result.rows[0]) : null;
  }

  async setHandoff(userId: string, handoff: boolean): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.query('INSERT INTO sessions (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
      await tx.query('SELECT user_id FROM sessions WHERE user_id = $1 FOR UPDATE', [userId]);
      await tx.query('UPDATE sessions SET handoff = $2 WHERE user_id = $1', [userId, handoff]);
    });
  }

  async claimEvent(filter: { onlyUserId?: string; excludeUserId?: string } = {}): Promise<EventJob | null> {
    return this.db.transaction(async tx => {
      const result = await tx.query<EventRow>(`SELECT e.*, s.customer_ref FROM events e
        JOIN sessions s ON s.user_id = e.user_id
        WHERE (e.status = 'pending' OR (e.status = 'processing' AND e.lease_until < clock_timestamp()))
          AND ($1::text IS NULL OR e.user_id = $1) AND ($2::text IS NULL OR e.user_id <> $2)
          AND NOT EXISTS (SELECT 1 FROM events predecessor WHERE predecessor.user_id = e.user_id
            AND predecessor.sequence < e.sequence AND predecessor.status IN ('pending', 'processing'))
        ORDER BY e.sequence LIMIT 1 FOR UPDATE OF e, s SKIP LOCKED`, [filter.onlyUserId ?? null, filter.excludeUserId ?? null]);
      const row = result.rows[0];
      if (!row) return null;
      const leaseToken = randomUUID();
      await tx.query(`UPDATE events SET status = 'processing', attempts = attempts + 1,
        lease_token = $2, lease_until = clock_timestamp() + interval '90 seconds' WHERE id = $1`, [row.id, leaseToken]);
      const receivedAt = new Date(row.received_at);
      return {
        id: row.id, userId: row.user_id, customerRef: row.customer_ref,
        event: row.payload ?? { type: 'message', webhookEventId: row.id, timestamp: receivedAt.getTime(), source: { type: 'user', userId: row.user_id }, message: { type: 'expired' } },
        receivedAt, leaseToken, previouslySending: row.send_started !== null,
        attempts: row.attempts + 1,
      };
    });
  }

  async markSending(job: EventJob, ignoreHandoff = false): Promise<boolean> {
    return this.db.transaction(async tx => {
      const session = await tx.query<SessionRow>('SELECT user_id, customer_ref, handoff FROM sessions WHERE user_id = $1 FOR UPDATE', [job.userId]);
      if (!session.rows[0] || (session.rows[0].handoff && !ignoreHandoff)) return false;
      const result = await tx.query(`UPDATE events SET send_started = now() WHERE id = $1 AND user_id = $2
        AND status = 'processing' AND lease_token = $3 AND lease_until > clock_timestamp() AND send_started IS NULL
        AND text_removed_at IS NULL AND ingested_at > now() - interval '30 days' RETURNING id`, [job.id, job.userId, job.leaseToken]);
      return result.rows.length === 1;
    });
  }

  async finishEvent(job: EventJob, outcome: Outcome, ownerId: string): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.query('SELECT user_id FROM sessions WHERE user_id = $1 FOR UPDATE', [job.userId]);
      const locked = await tx.query<EventRow>(`SELECT *, ingested_at < now() - interval '30 days' AS expired FROM events WHERE id = $1 AND user_id = $2
        AND status = 'processing' AND lease_token = $3 AND lease_until > clock_timestamp() FOR UPDATE`, [job.id, job.userId, job.leaseToken]);
      const row = locked.rows[0];
      if (!row) return;
      const redacted = row.text_removed_at !== null || row.expired === true;
      const safeOutcome: Outcome = redacted ? { ...outcome, reply: '', summary: REDACTED, service: null, requestedTime: null, nextAction: REDACTED } : outcome;
      await tx.query(`UPDATE events SET status = 'done', outcome = $2::jsonb, delivery = $3,
        completed_at = now(), lease_until = NULL, lease_token = NULL,
        payload = CASE WHEN $4::boolean THEN NULL ELSE payload END,
        text_removed_at = CASE WHEN $4::boolean THEN COALESCE(text_removed_at, now()) ELSE text_removed_at END
        WHERE id = $1`, [job.id, redacted ? null : JSON.stringify(safeOutcome), safeOutcome.delivery, redacted]);
      if (safeOutcome.skipTask) return;
      const task = await tx.query<{ id: string }>(`INSERT INTO tasks (event_id, user_id, status, booking_status,
        summary, next_action, service, requested_time, received_at, closed_at, text_removed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $3 = 'done' THEN now() ELSE NULL END,
          CASE WHEN $10::boolean THEN now() ELSE NULL END) RETURNING id`,
      [job.id, job.userId, safeOutcome.needsHuman ? 'open' : 'done', safeOutcome.bookingStatus, safeOutcome.summary,
        safeOutcome.nextAction, safeOutcome.service, safeOutcome.requestedTime, job.receivedAt, redacted]);
      if (safeOutcome.needsHuman) await tx.query('UPDATE sessions SET handoff = true WHERE user_id = $1', [job.userId]);
      const taskId = task.rows[0]!.id;
      await tx.query(`INSERT INTO notifications (id, task_id, owner_id, text, retry_key, text_removed_at)
        VALUES ($1,$2,$3,$4,$5,CASE WHEN $6::boolean THEN now() ELSE NULL END)`,
      [randomUUID(), taskId, ownerId, redacted ? REDACTED : formatNotification({ job, outcome: safeOutcome, taskId }), randomUUID(), redacted]);
    });
  }

  async history(userId: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const result = await this.db.query<{ payload: LineEvent; outcome: Outcome }>(`SELECT payload, outcome FROM events
      WHERE user_id = $1 AND status = 'done' AND payload IS NOT NULL AND outcome IS NOT NULL
        AND ingested_at > now() - interval '30 days' ORDER BY sequence DESC LIMIT 10`, [userId]);
    const turns: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const row of result.rows.reverse()) {
      if (row.payload.message?.type === 'text' && row.payload.message.text) turns.push({ role: 'user', content: row.payload.message.text });
      if (row.outcome.reply && row.outcome.delivery === 'sent') turns.push({ role: 'assistant', content: row.outcome.reply });
    }
    return turns.slice(-10);
  }

  async claimNotification(): Promise<NotificationJob | null> {
    return this.db.transaction(async tx => {
      // An expired final attempt is kept as unknown, never silently requeued.
      await tx.query(`UPDATE notifications SET status = 'unknown', lease_token = NULL, lease_until = NULL
        WHERE status = 'processing' AND lease_until < clock_timestamp() AND attempts >= 3`);
      const result = await tx.query<{ id: string; owner_id: string; text: string; retry_key: string; attempts: number }>(`SELECT * FROM notifications
        WHERE attempts < 3 AND next_attempt_at <= clock_timestamp() AND text_removed_at IS NULL AND created_at > now() - interval '30 days'
          AND (status IN ('pending','failed','unknown') OR (status = 'processing' AND lease_until < clock_timestamp()))
        ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const row = result.rows[0];
      if (!row) return null;
      const leaseToken = randomUUID();
      await tx.query(`UPDATE notifications SET status = 'processing', attempts = attempts + 1,
        lease_token = $2, lease_until = clock_timestamp() + interval '90 seconds' WHERE id = $1`, [row.id, leaseToken]);
      return { id: row.id, ownerId: row.owner_id, text: row.text, retryKey: row.retry_key, leaseToken, attempts: row.attempts + 1 };
    });
  }

  async finishNotification(job: NotificationJob, status: 'sent' | 'failed' | 'unknown'): Promise<void> {
    await this.db.query(`UPDATE notifications SET status = $3, lease_token = NULL, lease_until = NULL,
      next_attempt_at = clock_timestamp() + CASE WHEN attempts = 1 THEN interval '30 seconds' ELSE interval '2 minutes' END
      WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND lease_until > clock_timestamp()`, [job.id, job.leaseToken, status]);
  }

  async listTasks(beforeId?: string): Promise<Task[]> {
    const result = await this.db.query<TaskRow>(`SELECT t.*, s.customer_ref FROM tasks t JOIN sessions s ON s.user_id = t.user_id
      WHERE t.status = 'open' AND ($1::text IS NULL OR t.task_number < (SELECT task_number FROM tasks WHERE id = $1))
      ORDER BY t.task_number DESC LIMIT 20`, [beforeId ?? null]);
    return result.rows.map(taskFrom);
  }

  async getTask(ref: string): Promise<Task | null> {
    const result = await this.db.query<TaskRow>('SELECT t.*, s.customer_ref FROM tasks t JOIN sessions s ON s.user_id = t.user_id WHERE t.id = $1', [ref]);
    return result.rows[0] ? taskFrom(result.rows[0]) : null;
  }

  async completeTask(ref: string): Promise<boolean> {
    const result = await this.db.query("UPDATE tasks SET status = 'done', closed_at = COALESCE(closed_at, now()) WHERE id = $1 RETURNING id", [ref]);
    return result.rows.length === 1;
  }

  async confirmTask(ref: string): Promise<boolean> {
    const result = await this.db.query("UPDATE tasks SET booking_status = 'owner_confirmed', confirmation_source = 'owner_confirmation' WHERE id = $1 AND booking_status IN ('requested','self_reported','owner_confirmed') RETURNING id", [ref]);
    return result.rows.length === 1;
  }

  async addFeedback(ref: string, text: string): Promise<boolean> {
    const result = await this.db.query('INSERT INTO feedback (task_id, text) SELECT id, $2 FROM tasks WHERE id = $1 RETURNING id', [ref, text]);
    return result.rows.length === 1;
  }

  async cleanup(): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.query(`UPDATE events SET payload = NULL, outcome = NULL, text_removed_at = now()
        WHERE ingested_at < now() - interval '30 days' AND text_removed_at IS NULL`);
      await tx.query(`UPDATE tasks SET summary = $1, next_action = $1, service = NULL, requested_time = NULL, text_removed_at = now()
        WHERE created_at < now() - interval '30 days' AND text_removed_at IS NULL`, [REDACTED]);
      await tx.query(`UPDATE notifications SET text = $1, text_removed_at = now()
        WHERE created_at < now() - interval '30 days' AND text_removed_at IS NULL`, [REDACTED]);
      await tx.query(`UPDATE feedback SET text = $1, text_removed_at = now()
        WHERE created_at < now() - interval '30 days' AND text_removed_at IS NULL`, [REDACTED]);
      await tx.query("DELETE FROM tasks WHERE status = 'done' AND closed_at < now() - interval '90 days'");
      await tx.query(`DELETE FROM events e WHERE e.status = 'done' AND e.ingested_at < now() - interval '90 days'
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.event_id = e.id)`);
    });
  }
}
