import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { providerFetch } from '../providers/http.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z
  .object({
    channel: z.string().min(1),
    text: z.string().min(1).max(40000),
    /** Reply inside a thread. Slack's own field name, kept so the docs transfer. */
    threadTs: z.string().min(1).optional(),
  })
  .strict();

const DEFAULT_BASE = 'https://slack.com';

/**
 * Slack error codes worth trying again.
 *
 * Everything else is a decision Slack has already made — a bad token stays bad, and
 * retrying it burns the workflow's attempt budget and can trip Slack's own limiter.
 */
const RETRYABLE = new Set(['ratelimited', 'service_unavailable', 'internal_error', 'fatal_error']);

interface SlackResponse {
  ok?: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

function connOf(payload: unknown): { botToken: string; baseUrl?: string } {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.slack.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid slack connection payload', false);
  return parsed.data;
}

/**
 * Slack signals failure with HTTP 200 and `{ ok: false, error }`.
 *
 * `providerFetch` only throws on `!res.ok`, so without this every Slack failure — a
 * revoked token, a channel the bot was removed from — would be recorded as a successful
 * node and the workflow would carry on as though the message had been delivered.
 *
 * The thrown error deliberately carries NO `httpStatus`: `apps/worker/src/classify.ts`
 * overrides the retryable flag for anything that has one, which would turn `invalid_auth`
 * into three more attempts.
 */
function assertOk(data: SlackResponse): void {
  if (data.ok === true) return;
  const code = typeof data.error === 'string' && data.error !== '' ? data.error : 'unknown_error';
  throw new NodeRunError(`slack_${code}`, `slack rejected the request: ${code}`, RETRYABLE.has(code));
}

export const slackPostMessage: ConnectorDefinition = {
  type: 'slack.postMessage',
  kind: 'action',
  operationVersion: '0.1.0',
  defaultEffectClass: 'write',
  outputPorts: ['main'],
  display: {
    displayName: 'Post Slack message',
    description:
      'Post a message to a Slack channel the bot has been invited to. Give the channel id (C…) rather than the name; names change and ids do not.',
    category: 'Messaging',
    glyph: '#',
  },
  paramsSchema,
  requiresConnection: 'slack',
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const conn = connOf(ctx.connection);
    const data = (await providerFetch(
      `${conn.baseUrl ?? DEFAULT_BASE}/api/chat.postMessage`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${conn.botToken}` },
        body: {
          channel: parsed.data.channel,
          text: parsed.data.text,
          ...(parsed.data.threadTs ? { thread_ts: parsed.data.threadTs } : {}),
        },
      },
      ctx.signal,
    )) as SlackResponse;
    assertOk(data);
    return { output: { ts: data.ts ?? null, channel: data.channel ?? parsed.data.channel } };
  },
  async testConnection(payload, signal) {
    const conn = connOf(payload);
    // Not providerCheck: `auth.test` answers 200 with `ok: false` for a dead token, so a
    // status-only check would call every broken connection healthy.
    const data = (await providerFetch(
      `${conn.baseUrl ?? DEFAULT_BASE}/api/auth.test`,
      { method: 'POST', headers: { authorization: `Bearer ${conn.botToken}` }, body: {} },
      signal,
    )) as SlackResponse;
    if (data.ok !== true) throw new Error('connection test failed');
  },
};
