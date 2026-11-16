import { migrate, postgres } from './db.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = postgres(process.env.DATABASE_URL);
try { await migrate(db); console.log('Player platform migrations applied.'); }
finally { await db.close(); }
