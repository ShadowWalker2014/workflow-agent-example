import { Pool } from "pg";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL not set");
    pool = new Pool({ connectionString, max: 5 });
  }
  return pool;
}

export type NoteRow = {
  id: number;
  title: string;
  body: string;
  created_at: Date;
};

export async function saveNote(title: string, body: string): Promise<number> {
  const r = await getPool().query<{ id: number }>(
    `INSERT INTO notes (title, body) VALUES ($1, $2) RETURNING id`,
    [title, body],
  );
  return Number(r.rows[0].id);
}

export async function listNotes(): Promise<Array<Pick<NoteRow, "id" | "title" | "created_at">>> {
  const r = await getPool().query<Pick<NoteRow, "id" | "title" | "created_at">>(
    `SELECT id, title, created_at FROM notes ORDER BY created_at DESC LIMIT 50`,
  );
  return r.rows.map((row) => ({ ...row, id: Number(row.id) }));
}

export async function readNote(id: number): Promise<NoteRow | null> {
  const r = await getPool().query<NoteRow>(
    `SELECT id, title, body, created_at FROM notes WHERE id = $1`,
    [id],
  );
  if (!r.rows[0]) return null;
  return { ...r.rows[0], id: Number(r.rows[0].id) };
}
