import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  claimOutbox,
  createPool,
  deadLetterOutbox,
  fetchUnpublished,
  insertOutbox,
  listDeadLetters,
  markPublished,
  outboxHealth,
  releaseOutbox,
  replayDeadLetter,
  runMigrations,
} from '../src/index.js';

let pool: Pool;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM outbox_dead_letters');
  await pool.query('DELETE FROM task_outbox');
});

const seed = (n: number, eventType = 'node.task') =>
  Promise.all(Array.from({ length: n }, (_, i) => insertOutbox(pool, { eventType, payload: { i } })));

describe('claimOutbox', () => {
  test('two concurrent claims never hand back the same row', async () => {
    // Five publishers poll this table every 250ms. A plain SELECT gave all five the
    // same rows and only BullMQ jobId dedup kept that from being five times the work.
    await seed(20);
    const [a, b] = await Promise.all([claimOutbox(pool, 20), claimOutbox(pool, 20)]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(20);
  });

  test('a claimed row is invisible to the next claimer while the lease holds', async () => {
    await seed(3);
    expect(await claimOutbox(pool, 10)).toHaveLength(3);
    expect(await claimOutbox(pool, 10)).toHaveLength(0);
  });

  test('a lease that has expired is reclaimable, so a dead publisher strands nothing', async () => {
    await seed(2);
    await claimOutbox(pool, 10);
    // Zero lease: every existing claim is already stale.
    expect(await claimOutbox(pool, 10, 0)).toHaveLength(2);
  });

  test('claiming counts the attempt, so a row that keeps failing can be seen', async () => {
    await seed(1);
    expect((await claimOutbox(pool, 10))[0]!.attempts).toBe(1);
    expect((await claimOutbox(pool, 10, 0))[0]!.attempts).toBe(2);
  });

  test('a published row is never claimed again', async () => {
    await seed(1);
    const claimed = await claimOutbox(pool, 10);
    await markPublished(pool, claimed.map((r) => r.id));
    expect(await claimOutbox(pool, 10, 0)).toHaveLength(0);
  });

  test('releasing hands the row straight back rather than waiting out the lease', async () => {
    await seed(1);
    const [row] = await claimOutbox(pool, 10);
    await releaseOutbox(pool, row!.id, 'redis refused the connection');
    const again = await claimOutbox(pool, 10);
    expect(again).toHaveLength(1);
    expect(again[0]!.attempts).toBe(2);
  });

  test('fetchUnpublished inspects without claiming', async () => {
    await seed(2);
    expect(await fetchUnpublished(pool, 10)).toHaveLength(2);
    // Still claimable: reading is not taking.
    expect(await claimOutbox(pool, 10)).toHaveLength(2);
  });
});

describe('dead letters', () => {
  test('a dead-lettered row leaves the outbox entirely', async () => {
    // Left in place it was re-read and re-logged every 250ms by five processes, and
    // held a slot in every batch because the claim is ordered by age.
    await seed(1, 'nonsense.event');
    const [row] = await claimOutbox(pool, 10);
    await deadLetterOutbox(pool, row!, 'no queue is mapped to this event type');

    expect(await fetchUnpublished(pool, 10)).toHaveLength(0);
    const dead = await listDeadLetters(pool);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.eventType).toBe('nonsense.event');
    expect(dead[0]!.lastError).toContain('no queue');
  });

  test('replay writes a NEW outbox row and keeps the record of the failure', async () => {
    await seed(1, 'node.task');
    const [row] = await claimOutbox(pool, 10);
    await deadLetterOutbox(pool, row!, 'boom');
    const dead = await listDeadLetters(pool);

    expect(await replayDeadLetter(pool, dead[0]!.id)).toBe(true);
    const pending = await fetchUnpublished(pool, 10);
    expect(pending).toHaveLength(1);
    // A fresh row: replaying must not resurrect the id, or the evidence disappears.
    expect(pending[0]!.id).not.toBe(row!.id);
    expect(pending[0]!.attempts).toBe(0);
    // And it must publish under a DIFFERENT BullMQ job id than the original, or the
    // replay is silently deduplicated away and never runs.
    expect(pending[0]!.replaySeq).toBe(1);
    // And it is no longer offered as an open dead letter.
    expect(await listDeadLetters(pool)).toHaveLength(0);
  });

  test('replaying twice does nothing the second time', async () => {
    await seed(1);
    const [row] = await claimOutbox(pool, 10);
    await deadLetterOutbox(pool, row!, 'boom');
    const dead = await listDeadLetters(pool);
    expect(await replayDeadLetter(pool, dead[0]!.id)).toBe(true);
    expect(await replayDeadLetter(pool, dead[0]!.id)).toBe(false);
    expect(await fetchUnpublished(pool, 10)).toHaveLength(1);
  });

  test('replaying an unknown id is false, not a throw', async () => {
    expect(await replayDeadLetter(pool, '00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  test('the replay sequence keeps advancing if the work dies again', async () => {
    // Second replay must not collide with the first replay's job id either.
    await seed(1);
    for (const expected of [1, 2, 3]) {
      const [row] = await claimOutbox(pool, 10, 0);
      await deadLetterOutbox(pool, row!, 'boom');
      const [dead] = await listDeadLetters(pool);
      expect(await replayDeadLetter(pool, dead!.id)).toBe(true);
      expect((await fetchUnpublished(pool, 10))[0]!.replaySeq).toBe(expected);
    }
  });
});

describe('outboxHealth', () => {
  test('counts what is waiting, what is struggling and what has died', async () => {
    await seed(3);
    let health = await outboxHealth(pool);
    expect(health).toEqual({ pending: 3, struggling: 0, dead: 0 });

    // Claim the same rows past the attempt cap.
    for (let i = 0; i < 5; i += 1) await claimOutbox(pool, 10, 0);
    health = await outboxHealth(pool);
    expect(health.pending).toBe(3);
    expect(health.struggling).toBe(3);

    const [row] = await claimOutbox(pool, 1, 0);
    await deadLetterOutbox(pool, row!, 'gave up');
    health = await outboxHealth(pool);
    expect(health.pending).toBe(2);
    expect(health.dead).toBe(1);
  });
});
