import { createPool } from './pool.js';
import { runMigrations } from './migrate.js';

const pool = createPool();
const applied = await runMigrations(pool);
console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Nothing to apply');
await pool.end();
