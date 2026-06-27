import { Pool } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set. Did you copy .env.example to .env?");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS notes_created_at_idx ON notes (created_at DESC);
  `);
  console.log("[init-db] notes table ready");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
