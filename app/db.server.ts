import { Pool } from "pg";

// Singleton pool — one per Node process
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || "fraudengine",
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "",
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on("error", (err) => {
      console.error("[db] Unexpected error on idle client", err);
    });
  }
  return pool;
}

// ── Shop Tenants ───────────────────────────────────────────────────────────────

export interface ShopTenantRow {
  shopify_shop: string;
  tenant_id: string;
  api_key: string;
  tenant_name: string;
  created_at: Date;
}

export async function ensureShopTenantTable(): Promise<void> {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS shop_tenants (
      shopify_shop TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      api_key      TEXT NOT NULL,
      tenant_name  TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function getShopTenant(shop: string): Promise<ShopTenantRow | null> {
  const db = getPool();
  const res = await db.query<ShopTenantRow>(
    `SELECT * FROM shop_tenants WHERE shopify_shop = $1`,
    [shop]
  );
  return res.rows[0] ?? null;
}

export async function upsertShopTenant(row: Omit<ShopTenantRow, 'created_at'>): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO shop_tenants (shopify_shop, tenant_id, api_key, tenant_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (shopify_shop) DO UPDATE
       SET tenant_id = EXCLUDED.tenant_id,
           api_key   = EXCLUDED.api_key`,
    [row.shopify_shop, row.tenant_id, row.api_key, row.tenant_name]
  );
}

// ── Visitor Identifier ─────────────────────────────────────────────────────────

export interface VisitorIdentifierRow {
  id: string;
  tenant_id: string;
  visitor_id: string;
  device_id: string | null;
  ip_address: string | null;
  email: string | null;
  cart_id: string | null;
  customer_id: string | null;
  shopify_shop: string | null;
  first_seen: Date | null;
  last_seen: Date | null;
  confidence: number;
}

export async function upsertVisitorIdentifier(
  tenantId: string,
  visitorId: string,
  ipAddress?: string | null
): Promise<VisitorIdentifierRow> {
  const db = getPool();
  const res = await db.query<VisitorIdentifierRow>(
    `INSERT INTO visitor_identifier (id, tenant_id, visitor_id, ip_address, first_seen, last_seen)
     VALUES (gen_random_uuid(), $1, $2, $3, now(), now())
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [tenantId, visitorId, ipAddress ?? null]
  );
  if (res.rows.length) return res.rows[0];

  // Row already exists — touch last_seen and return
  const existing = await db.query<VisitorIdentifierRow>(
    `UPDATE visitor_identifier
        SET last_seen = now(),
            ip_address = COALESCE($3, ip_address)
      WHERE tenant_id = $1 AND visitor_id = $2
      RETURNING *`,
    [tenantId, visitorId, ipAddress ?? null]
  );
  return existing.rows[0];
}

export async function linkVisitorIdentity(
  tenantId: string,
  visitorId: string,
  signals: {
    email?: string | null;
    cartId?: string | null;
    customerId?: string | null;
    shopifyShop?: string | null;
  }
): Promise<{ row: VisitorIdentifierRow; confidence: number }> {
  const db = getPool();

  // Confidence scoring: each signal adds weight
  let confidence = 0.0;
  if (signals.email) confidence += 0.6;
  if (signals.customerId) confidence += 0.3;
  if (signals.cartId) confidence += 0.1;
  confidence = Math.min(confidence, 1.0);

  const res = await db.query<VisitorIdentifierRow>(
    `UPDATE visitor_identifier
        SET email        = COALESCE($3, email),
            cart_id      = COALESCE($4, cart_id),
            customer_id  = COALESCE($5, customer_id),
            shopify_shop = COALESCE($6, shopify_shop),
            confidence   = GREATEST(confidence, $7),
            last_seen    = now()
      WHERE tenant_id = $1 AND visitor_id = $2
      RETURNING *`,
    [
      tenantId,
      visitorId,
      signals.email ?? null,
      signals.cartId ?? null,
      signals.customerId ?? null,
      signals.shopifyShop ?? null,
      confidence,
    ]
  );
  return { row: res.rows[0], confidence };
}

export async function resolveVisitorBySignals(
  tenantId: string,
  signals: {
    email?: string | null;
    cartId?: string | null;
    customerId?: string | null;
    shopifyShop?: string | null;
  }
): Promise<{ row: VisitorIdentifierRow | null; confidence: number }> {
  const db = getPool();
  const conditions: string[] = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  let paramIdx = 2;

  // Ordered by confidence: email > customer_id > cart_id
  if (signals.email) {
    conditions.push(`email = $${paramIdx++}`);
    params.push(signals.email);
  } else if (signals.customerId) {
    conditions.push(`customer_id = $${paramIdx++}`);
    params.push(signals.customerId);
  } else if (signals.cartId) {
    conditions.push(`cart_id = $${paramIdx++}`);
    params.push(signals.cartId);
  }

  if (conditions.length === 1) return { row: null, confidence: 0 };

  const res = await db.query<VisitorIdentifierRow>(
    `SELECT * FROM visitor_identifier WHERE ${conditions.join(" AND ")}
     ORDER BY last_seen DESC NULLS LAST LIMIT 1`,
    params
  );

  let confidence = 0.0;
  if (res.rows.length) {
    if (signals.email) confidence = 0.9;
    else if (signals.customerId) confidence = 0.7;
    else confidence = 0.4;
  }
  return { row: res.rows[0] ?? null, confidence };
}

// ── Session Events ─────────────────────────────────────────────────────────────

export interface SessionEventInsert {
  tenantId: string;
  visitorId: string;
  requestId?: string | null;
  timestamp: string;
  page?: string | null;
  devicePayload?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export async function insertSessionEvent(evt: SessionEventInsert): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO session_events
       (id, tenant_id, visitor_id, request_id, timestamp, page, device_payload, ip_address)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
    [
      evt.tenantId,
      evt.visitorId,
      evt.requestId ?? null,
      evt.timestamp,
      evt.page ?? null,
      evt.devicePayload ? JSON.stringify(evt.devicePayload) : null,
      evt.ipAddress ?? null,
    ]
  );
}

export async function getRecentSessionEvents(
  tenantId: string,
  visitorId: string,
  limit = 20
) {
  const db = getPool();
  const res = await db.query(
    `SELECT * FROM session_events
      WHERE tenant_id = $1 AND visitor_id = $2
      ORDER BY timestamp DESC LIMIT $3`,
    [tenantId, visitorId, limit]
  );
  return res.rows;
}

// ── Order Link ─────────────────────────────────────────────────────────────────

export interface OrderLinkRow {
  id: string;
  tenant_id: string;
  shopify_order_id: string;
  shopify_shop: string;
  visitor_identifier_id: string | null;
  join_confidence: number;
  raw_order: Record<string, unknown> | null;
  score: number | null;
  decision: string | null;
  reasons: string[] | null;
  fraud_request_id: string | null;
  action_status: string | null;
  action_detail: string | null;
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date | null;
}

export async function upsertOrderLink(data: {
  tenantId: string;
  shopifyOrderId: string;
  shopifyShop: string;
  visitorIdentifierId?: string | null;
  joinConfidence?: number;
  rawOrder?: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<OrderLinkRow> {
  const db = getPool();
  const res = await db.query<OrderLinkRow>(
    `INSERT INTO order_link
       (id, tenant_id, shopify_order_id, shopify_shop,
        visitor_identifier_id, join_confidence, raw_order,
        action_status, idempotency_key)
     VALUES
       (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'pending', $7)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET visitor_identifier_id = COALESCE(EXCLUDED.visitor_identifier_id, order_link.visitor_identifier_id),
           join_confidence        = GREATEST(EXCLUDED.join_confidence, order_link.join_confidence),
           updated_at             = now()
     RETURNING *`,
    [
      data.tenantId,
      data.shopifyOrderId,
      data.shopifyShop,
      data.visitorIdentifierId ?? null,
      data.joinConfidence ?? 0.0,
      data.rawOrder ? JSON.stringify(data.rawOrder) : null,
      data.idempotencyKey,
    ]
  );
  return res.rows[0];
}

export async function updateOrderLinkDecision(
  orderLinkId: string,
  score: number,
  decision: string,
  reasons: string[],
  fraudRequestId?: string | null
): Promise<void> {
  const db = getPool();
  await db.query(
    `UPDATE order_link
        SET score = $2, decision = $3, reasons = $4, fraud_request_id = $5, updated_at = now()
      WHERE id = $1`,
    [orderLinkId, score, decision, JSON.stringify(reasons), fraudRequestId ?? null]
  );
}

export async function updateOrderLinkAction(
  orderLinkId: string,
  actionStatus: string,
  actionDetail?: string
): Promise<void> {
  const db = getPool();
  await db.query(
    `UPDATE order_link
        SET action_status = $2, action_detail = $3, updated_at = now()
      WHERE id = $1`,
    [orderLinkId, actionStatus, actionDetail ?? null]
  );
}

export async function getRecentOrderLinks(
  tenantId: string,
  limit = 50
): Promise<OrderLinkRow[]> {
  const db = getPool();
  const res = await db.query<OrderLinkRow>(
    `SELECT * FROM order_link WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit]
  );
  return res.rows;
}
