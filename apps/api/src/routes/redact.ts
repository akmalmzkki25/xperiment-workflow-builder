/**
 * Moved to `@xperiment/db` so `appendAgentMessage` can call it internally — a transcript that
 * relies on every caller remembering to redact is a transcript that will one day hold a
 * bot token. Re-exported from the old path so the two route importers and the existing
 * test file are untouched.
 */
export { redactSecrets, REDACTED, looksLikeCredential } from '@xperiment/db';
