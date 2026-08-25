import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/**
 * `next build` and `next dev` both claim `.next` by default, so running a build while a
 * dev server is up replaces the chunks that server is still handing out and every page
 * 404s its JavaScript until the server is restarted — the page renders but never
 * hydrates, which looks like a component bug rather than a build collision. Giving the
 * production build its own directory removes the clash outright.
 */
export default function config(phase) {
  return {
    reactStrictMode: true,
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next' : '.next-build',
  };
}
