import pg from "pg";
import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-api";

function createPool(): pg.Pool {
  const host = process.env.DB_HOST || "localhost";
  const port = parseInt(process.env.DB_PORT || "5432");
  const database = process.env.DB_NAME || "fraudengine";
  const user = process.env.DB_USER || "postgres";
  const password = process.env.DB_PASSWORD || "";

  if (host.startsWith("/")) {
    // Unix socket — Cloud SQL on Cloud Run. Pass host as config object (not URL).
    return new pg.Pool({ host, database, user, password });
  }
  return new pg.Pool({ host, port, database, user, password });
}

const pool = createPool();

const tableReady: Promise<void> = pool
  .query(
    `CREATE TABLE IF NOT EXISTS shopify_sessions (
      id    VARCHAR(255) NOT NULL PRIMARY KEY,
      shop  VARCHAR(255) NOT NULL,
      content TEXT        NOT NULL
    )`
  )
  .then(() => undefined)
  .catch((err) => console.error("[sessions] table init error:", err));

export class PgSessionStorage implements SessionStorage {
  async storeSession(session: Session): Promise<boolean> {
    await tableReady;
    const content = JSON.stringify(session.toPropertyArray());
    await pool.query(
      `INSERT INTO shopify_sessions (id, shop, content) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET shop = $2, content = $3`,
      [session.id, session.shop, content]
    );
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    await tableReady;
    const { rows } = await pool.query(
      "SELECT content FROM shopify_sessions WHERE id = $1",
      [id]
    );
    if (!rows[0]) return undefined;
    return Session.fromPropertyArray(JSON.parse(rows[0].content));
  }

  async deleteSession(id: string): Promise<boolean> {
    await tableReady;
    await pool.query("DELETE FROM shopify_sessions WHERE id = $1", [id]);
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    await tableReady;
    if (!ids.length) return true;
    await pool.query("DELETE FROM shopify_sessions WHERE id = ANY($1)", [ids]);
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    await tableReady;
    const { rows } = await pool.query(
      "SELECT content FROM shopify_sessions WHERE shop = $1",
      [shop]
    );
    return rows.map((r) => Session.fromPropertyArray(JSON.parse(r.content)));
  }
}
