/**
 * POST /api/v1/session/ingest
 *
 * Receives raw storefront signals (device fingerprint, page URL, IP) for a
 * given visitor/tenant pair.  Persists one row into session_events and
 * ensures the visitor_identifier row exists.
 *
 * Auth: X-API-Key header matched against the tenant row in Postgres.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import {
  getPool,
  insertSessionEvent,
  upsertVisitorIdentifier,
} from "~/db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const apiKey = request.headers.get("X-API-Key") ?? "";
  const tenantId = await resolveTenantByApiKey(apiKey);
  if (!tenantId) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: IngestPayload;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { visitor_id, request_id, timestamp, page, device, ip } = body;

  if (!visitor_id || !timestamp) {
    return json(
      { error: "visitor_id and timestamp are required" },
      { status: 400 }
    );
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  await upsertVisitorIdentifier(tenantId, visitor_id, ip ?? null);

  await insertSessionEvent({
    tenantId,
    visitorId: visitor_id,
    requestId: request_id ?? null,
    timestamp,
    page: page ?? null,
    devicePayload: device ?? null,
    ipAddress: ip ?? null,
  });

  return json({ ok: true, visitor_id, tenant_id: tenantId }, { status: 200 });
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface IngestPayload {
  visitor_id: string;
  request_id?: string;
  timestamp: string;
  page?: string;
  ip?: string;
  device?: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveTenantByApiKey(
  apiKey: string
): Promise<string | null> {
  if (!apiKey) return null;
  const db = getPool();
  const res = await db.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM tenant WHERE api_key = $1 LIMIT 1`,
    [apiKey]
  );
  return res.rows[0]?.tenant_id ?? null;
}
