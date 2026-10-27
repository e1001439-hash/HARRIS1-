import { randomUUID } from 'node:crypto';
import { formatNotification, formatReceipt } from './notifications.js';
import type { Database, EventJob, LineEvent, NotificationJob, Outcome, Session, Task } from './types.js';

const REDACTED = '[已依保存期限移除]';
// The LINE source timestamp is authoritative; insertion sequence breaks ties.
const latestEventSql = `NOT EXISTS (SELECT 1 FROM events newer WHERE newer.user_id = e.user_id
  AND (newer.received_at, newer.sequence) > (e.received_at, e.sequence))`;
type EventRow = {
  id: string; user_id: string; customer_ref: string; payload: LineEvent | null;
  received_at: Date | string; attempts: number; lease_token: string;
  send_started: Date | null; text_removed_at: Date | null;
  manual_handoff: boolean; handoff?: boolean; handoff_revision?: number;
  expired?: boolean;
};
type SessionRow = { user_id: string; customer_ref: string; handoff: boolean; assistant_intro_event_id?: string | null };
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

  async ingest(events: LineEvent[], ownerId?: string): Promise<void> {
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
        const receivedAt = new Date(event.timestamp);
        const inserted = await tx.query(`INSERT INTO events (id, user_id, payload, received_at, manual_handoff)
          SELECT $1, $2, $3::jsonb, $4, handoff FROM sessions WHERE user_id = $2
          ON CONFLICT (id) DO NOTHING RETURNING id`, [event.webhookEventId, userId, JSON.stringify(event), receivedAt]);
        if (!inserted.rows.length || ownerId === undefined || userId === ownerId) continue;
        const session = await tx.query<SessionRow>('SELECT user_id, customer_ref, handoff FROM sessions WHERE user_id = $1', [userId]);
        const text = event.message?.type === 'text' ? event.message.text ?? '' : `[非文字訊息：${event.message?.type ?? event.type}]`;
        const task = await tx.query<{ id: string }>(`INSERT INTO tasks (event_id, user_id, status, booking_status, summary, next_action, received_at)
          VALUES ($1,$2,'open','none',$3,'訊息待整理，請店主確認需求',$4) RETURNING id`,
        [event.webhookEventId, userId, text.slice(0, 1000), receivedAt]);
        const taskId = task.rows[0]!.id;
        await tx.query(`INSERT INTO notifications (id, task_id, owner_id, text, retry_key, phase)
          VALUES ($1,$2,$3,$4,$5,'receipt')`, [randomUUID(), taskId, ownerId,
          formatReceipt({ customerRef: session.rows[0]!.customer_ref, receivedAt, text, taskId }), randomUUID()]);
      }
    });
  }

  async isLatestEvent(job: EventJob): Promise<boolean> {
    const result = await this.db.query(`SELECT e.id FROM events e WHERE e.id = $1 AND e.user_id = $2 AND ${latestEventSql}`, [job.id, job.userId]);
    return result.rows.length === 1;
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
      await tx.query('UPDATE sessions SET handoff = $2, handoff_revision = handoff_revision + 1 WHERE user_id = $1', [userId, handoff]);
      if (handoff) await tx.query(`UPDATE events SET manual_handoff = true WHERE user_id = $1 AND status IN ('pending', 'processing')`, [userId]);
    });
  }

  async claimEvent(filter: { onlyUserId?: string; excludeUserId?: string } = {}): Promise<EventJob | null> {
    return this.db.transaction(async tx => {
      const result = await tx.query<EventRow>(`SELECT e.*, s.customer_ref, s.handoff, s.handoff_revision FROM events e
        JOIN sessions s ON s.user_id = e.user_id
        WHERE (e.status = 'pending' OR (e.status = 'processing' AND e.lease_until < clock_timestamp()))
          AND ($1::text IS NULL OR e.user_id = $1) AND ($2::text IS NULL OR e.user_id <> $2)
          AND NOT EXISTS (SELECT 1 FROM events predecessor WHERE predecessor.user_id = e.user_id
            AND predecessor.sequence < e.sequence AND predecessor.status IN ('pending', 'processing'))
        ORDER BY e.sequence LIMIT 1 FOR UPDATE OF e, s SKIP LOCKED`, [filter.onlyUserId ?? null, filter.excludeUserId ?? null]);
      const row = result.rows[0];
      if (!row) return null;
      const leaseToken = randomUUID();
      const manualHandoff = row.manual_handoff || row.handoff === true;
      await tx.query(`UPDATE events SET status = 'processing', attempts = attempts + 1,
        lease_token = $2, lease_until = clock_timestamp() + interval '90 seconds',
        manual_handoff = manual_handoff OR $3 WHERE id = $1`, [row.id, leaseToken, manualHandoff]);
      const receivedAt = new Date(row.received_at);
      return {
        id: row.id, userId: row.user_id, customerRef: row.customer_ref,
        event: row.payload ?? { type: 'message', webhookEventId: row.id, timestamp: receivedAt.getTime(), source: { type: 'user', userId: row.user_id }, message: { type: 'expired' } },
        receivedAt, leaseToken, previouslySending: row.send_started !== null,
        attempts: row.attempts + 1, manualHandoff, handoffRevision: row.handoff_revision ?? 0,
      };
    });
  }

  async markSending(job: EventJob, ignoreHandoff = false): Promise<false | { introduceAssistant: boolean }> {
    return this.db.transaction(async tx => {
      const session = await tx.query<SessionRow>('SELECT user_id, customer_ref, handoff, assistant_intro_event_id FROM sessions WHERE user_id = $1 FOR UPDATE', [job.userId]);
      if (!session.rows[0] || (session.rows[0].handoff && !ignoreHandoff)) return false;
      const result = await tx.query(`UPDATE events e SET send_started = now() WHERE id = $1 AND user_id = $2
        AND status = 'processing' AND lease_token = $3 AND lease_until > clock_timestamp() AND send_started IS NULL
        AND text_removed_at IS NULL AND ingested_at > now() - interval '30 days'
        AND ($4::boolean OR (NOT manual_handoff AND ${latestEventSql})) RETURNING id`, [job.id, job.userId, job.leaseToken, ignoreHandoff]);
      if (!result.rows.length) return false;
      const introduceAssistant = !ignoreHandoff && session.rows[0].assistant_intro_event_id === null;
      if (introduceAssistant) await tx.query('UPDATE sessions SET assistant_intro_event_id=$2 WHERE user_id=$1', [job.userId, job.id]);
      return { introduceAssistant };
    });
  }

  async reserveOwnerPreview(job: EventJob): Promise<'allowed' | 'duplicate' | 'rate_limited' | 'expired'> {
    return this.db.transaction(async tx => {
      // Keep the lock and the following reads in separate statements so a
      // concurrent reservation is visible after waiting for this owner's lock.
      await tx.query('SELECT user_id FROM sessions WHERE user_id = $1 FOR UPDATE', [job.userId]);
      const active = await tx.query<{ owner_preview_started_at: Date | null }>(`SELECT owner_preview_started_at FROM events
        WHERE id=$1 AND user_id=$2 AND status='processing' AND attempts=1 AND lease_token=$3
          AND lease_until > clock_timestamp() AND text_removed_at IS NULL FOR UPDATE`, [job.id, job.userId, job.leaseToken]);
      if (!active.rows[0]) return 'expired';
      if (active.rows[0].owner_preview_started_at !== null) return 'duplicate';
      const budget = await tx.query<{ total: number; recent: boolean }>(`SELECT count(*)::int AS total,
        COALESCE(bool_or(owner_preview_started_at > clock_timestamp()-interval '10 seconds'), false) AS recent
        FROM events WHERE user_id=$1 AND owner_preview_started_at > clock_timestamp()-interval '24 hours'`, [job.userId]);
      if (budget.rows[0]!.recent || budget.rows[0]!.total >= 20) return 'rate_limited';
      await tx.query('UPDATE events SET owner_preview_started_at=clock_timestamp() WHERE id=$1', [job.id]);
      return 'allowed';
    });
  }

  async finishEvent(job: EventJob, outcome: Outcome, ownerId: string): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.query('SELECT user_id FROM sessions WHERE user_id = $1 FOR UPDATE', [job.userId]);
      const locked = await tx.query<EventRow>(`SELECT *, ingested_at < now() - interval '30 days' AS expired FROM events WHERE id = $1 AND user_id = $2
        AND status = 'processing' AND lease_token = $3 AND lease_until > clock_timestamp() FOR UPDATE`, [job.id, job.userId, job.leaseToken]);
      const row = locked.rows[0];
      if (!row) return;
      const redacted = row.text_removed_at !== null || row.expired === true || outcome.privateSetup === true;
      const safeOutcome: Outcome = redacted ? { ...outcome, reply: '', summary: REDACTED, service: null, requestedTime: null, nextAction: REDACTED } : outcome;
      // Only an explicitly rejected send releases this event's reservation.
      // Unknown delivery or a crash retains it, preventing repeated disclosure.
      if (safeOutcome.delivery === 'failed' && !safeOutcome.skipTask) {
        await tx.query('UPDATE sessions SET assistant_intro_event_id=NULL WHERE user_id=$1 AND assistant_intro_event_id=$2', [job.userId, job.id]);
      }
      await tx.query(`UPDATE events SET status = 'done', outcome = $2::jsonb, delivery = $3,
        completed_at = now(), lease_until = NULL, lease_token = NULL,
        payload = CASE WHEN $4::boolean THEN NULL ELSE payload END,
        text_removed_at = CASE WHEN $4::boolean THEN COALESCE(text_removed_at, now()) ELSE text_removed_at END
        WHERE id = $1`, [job.id, redacted ? null : JSON.stringify(safeOutcome), safeOutcome.delivery, redacted]);
      if (safeOutcome.skipTask) return;
      const task = await tx.query<{ id: string }>(`INSERT INTO tasks (event_id, user_id, status, booking_status,
        summary, next_action, service, requested_time, received_at, closed_at, text_removed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $3 = 'done' THEN now() ELSE NULL END,
          CASE WHEN $10::boolean THEN now() ELSE NULL END)
        ON CONFLICT (event_id) DO UPDATE SET
          status = CASE WHEN tasks.status = 'done' THEN tasks.status ELSE EXCLUDED.status END,
          closed_at = COALESCE(tasks.closed_at, EXCLUDED.closed_at),
          booking_status = CASE WHEN tasks.booking_status = 'owner_confirmed' THEN tasks.booking_status ELSE EXCLUDED.booking_status END,
          summary = CASE WHEN tasks.text_removed_at IS NOT NULL THEN $11 ELSE EXCLUDED.summary END,
          next_action = CASE WHEN tasks.text_removed_at IS NOT NULL THEN $11 ELSE EXCLUDED.next_action END,
          service = CASE WHEN tasks.text_removed_at IS NOT NULL THEN NULL ELSE EXCLUDED.service END,
          requested_time = CASE WHEN tasks.text_removed_at IS NOT NULL THEN NULL ELSE EXCLUDED.requested_time END,
          text_removed_at = COALESCE(tasks.text_removed_at, EXCLUDED.text_removed_at)
        RETURNING id`,
      [job.id, job.userId, safeOutcome.needsHuman ? 'open' : 'done', safeOutcome.bookingStatus, safeOutcome.summary,
        safeOutcome.nextAction, safeOutcome.service, safeOutcome.requestedTime, job.receivedAt, redacted, REDACTED]);
      if (safeOutcome.needsHuman && !safeOutcome.preserveHandoff && !row.manual_handoff) {
        await tx.query('UPDATE sessions SET handoff = true WHERE user_id = $1 AND handoff_revision = $2', [job.userId, job.handoffRevision ?? 0]);
      }
      const taskId = task.rows[0]!.id;
      if (redacted) {
        await tx.query(`UPDATE notifications SET text = $2, text_removed_at = COALESCE(text_removed_at, now()) WHERE task_id = $1`, [taskId, REDACTED]);
      }
      const latest = await tx.query(`SELECT e.id FROM events e WHERE e.id = $1 AND ${latestEventSql}`, [job.id]);
      if (!latest.rows.length) return;
      const text = redacted ? REDACTED : formatNotification({ job, outcome: safeOutcome, taskId });
      // Keep the original receipt independent: suppressing an outdated analysis
      // must never erase the only notification for that source message.
      await tx.query(`INSERT INTO notifications (id, task_id, owner_id, text, retry_key, phase, text_removed_at)
        VALUES ($1,$2,$3,$4,$5,'analysis',CASE WHEN $6::boolean THEN now() ELSE NULL END)
        ON CONFLICT (task_id, phase) DO NOTHING`,
      [randomUUID(), taskId, ownerId, text, randomUUID(), redacted]);
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
      await tx.query(`UPDATE notifications n SET status = 'superseded', lease_token = NULL, lease_until = NULL
        FROM tasks t JOIN events e ON e.id = t.event_id
        WHERE n.task_id = t.id AND n.phase = 'analysis' AND n.status NOT IN ('sent', 'superseded')
          AND NOT (${latestEventSql})`);
      // A receipt with an expired claim is also obsolete once its analysis arrived.
      await tx.query(`UPDATE notifications receipt SET status = 'superseded', lease_token = NULL, lease_until = NULL
        WHERE receipt.phase = 'receipt' AND receipt.status NOT IN ('sent', 'superseded')
          AND (receipt.status <> 'processing' OR receipt.lease_until < clock_timestamp())
          AND EXISTS (SELECT 1 FROM notifications analysis WHERE analysis.task_id = receipt.task_id
            AND analysis.phase = 'analysis' AND analysis.status = 'sent')`);
      // An expired final attempt is kept as unknown, never silently requeued.
      await tx.query(`UPDATE notifications SET status = 'unknown', lease_token = NULL, lease_until = NULL
        WHERE status = 'processing' AND lease_until < clock_timestamp() AND attempts >= 3`);
      const result = await tx.query<{ id: string; owner_id: string; text: string; retry_key: string; attempts: number; phase: 'receipt' | 'analysis'; event_id: string; user_id: string }>(
        `SELECT n.*, t.event_id, t.user_id FROM notifications n JOIN tasks t ON t.id = n.task_id JOIN events e ON e.id = t.event_id
        WHERE n.attempts < 3 AND n.next_attempt_at <= clock_timestamp()
          AND n.text_removed_at IS NULL AND n.created_at > now() - interval '30 days'
          AND t.text_removed_at IS NULL AND t.created_at > now() - interval '30 days'
          AND e.text_removed_at IS NULL AND e.ingested_at > now() - interval '30 days'
          AND (n.status IN ('pending','failed','unknown') OR (n.status = 'processing' AND n.lease_until < clock_timestamp()))
          AND (n.phase = 'receipt' OR ${latestEventSql})
        ORDER BY n.created_at, n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED`);
      const row = result.rows[0];
      if (!row) return null;
      const leaseToken = randomUUID();
      await tx.query(`UPDATE notifications SET status = 'processing', attempts = attempts + 1,
        lease_token = $2, lease_until = clock_timestamp() + interval '90 seconds' WHERE id = $1`, [row.id, leaseToken]);
      return { id: row.id, ownerId: row.owner_id, text: row.text, retryKey: row.retry_key, leaseToken, attempts: row.attempts + 1,
        phase: row.phase, eventId: row.event_id, userId: row.user_id };
    });
  }

  async canSendNotification(job: NotificationJob): Promise<boolean> {
    return this.db.transaction(async tx => {
      await tx.query(`UPDATE notifications n SET status = 'superseded', lease_token = NULL, lease_until = NULL
        FROM tasks t JOIN events e ON e.id = t.event_id
        WHERE n.id = $1 AND n.lease_token = $2 AND n.status = 'processing' AND n.lease_until > clock_timestamp()
          AND n.task_id = t.id AND n.phase = 'analysis' AND NOT (${latestEventSql})`, [job.id, job.leaseToken]);
      const result = await tx.query(`SELECT n.id FROM notifications n JOIN tasks t ON t.id = n.task_id JOIN events e ON e.id = t.event_id
        WHERE n.id = $1 AND n.lease_token = $2 AND n.status = 'processing' AND n.lease_until > clock_timestamp()
          AND n.text_removed_at IS NULL AND n.created_at > now() - interval '30 days'
          AND t.text_removed_at IS NULL AND t.created_at > now() - interval '30 days'
          AND e.text_removed_at IS NULL AND e.ingested_at > now() - interval '30 days'
          AND (n.phase = 'receipt' OR ${latestEventSql})`, [job.id, job.leaseToken]);
      return result.rows.length === 1;
    });
  }

  async finishNotification(job: NotificationJob, status: 'sent' | 'failed' | 'unknown'): Promise<void> {
    await this.db.transaction(async tx => {
      const result = await tx.query<{ task_id: string; phase: string }>(`UPDATE notifications SET status = $3, lease_token = NULL, lease_until = NULL,
        next_attempt_at = clock_timestamp() + CASE WHEN attempts = 1 THEN interval '30 seconds' ELSE interval '2 minutes' END
        WHERE id = $1 AND lease_token = $2 AND status = 'processing' AND lease_until > clock_timestamp() RETURNING task_id, phase`, [job.id, job.leaseToken, status]);
      const row = result.rows[0];
      if (row?.phase === 'analysis' && status === 'sent') {
        await tx.query(`UPDATE notifications SET status = 'superseded', lease_token = NULL, lease_until = NULL
          WHERE task_id = $1 AND phase = 'receipt' AND status NOT IN ('processing', 'sent', 'superseded')`, [row.task_id]);
      }
    });
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
        WHERE text_removed_at IS NULL AND (created_at < now() - interval '30 days'
          OR EXISTS (SELECT 1 FROM events e WHERE e.id = tasks.event_id AND e.text_removed_at IS NOT NULL))`, [REDACTED]);
      await tx.query(`UPDATE notifications SET text = $1, text_removed_at = now()
        WHERE text_removed_at IS NULL AND (created_at < now() - interval '30 days'
          OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = notifications.task_id AND t.text_removed_at IS NOT NULL))`, [REDACTED]);
      await tx.query(`UPDATE feedback SET text = $1, text_removed_at = now()
        WHERE created_at < now() - interval '30 days' AND text_removed_at IS NULL`, [REDACTED]);
      await tx.query("DELETE FROM tasks WHERE status = 'done' AND closed_at < now() - interval '90 days'");
      await tx.query(`DELETE FROM events e WHERE e.status = 'done' AND e.ingested_at < now() - interval '90 days'
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.event_id = e.id)`);
    });
  }
}
