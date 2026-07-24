import type { FastifyInstance } from 'fastify';
import { OPENAPI_DOCUMENT } from '../openapi.js';

export function registerOpenapiRoutes(app: FastifyInstance): void {
  // Public + rate-exempt (see auth plugin EXEMPT and rate-limit EXEMPT).
  app.get('/v1/openapi.json', async () => OPENAPI_DOCUMENT);
}
