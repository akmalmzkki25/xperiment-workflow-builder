import type { FastifyReply } from 'fastify';

export function sendProblem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
  errors?: unknown[],
): void {
  void reply
    .status(status)
    .header('content-type', 'application/problem+json')
    .send({ type: 'about:blank', title, status, ...(detail ? { detail } : {}), ...(errors ? { errors } : {}) });
}
