/**
 * POST /api/v1/session/link
 *
 * Links identity signals (email, cart token, Shopify customer ID) to an
 * existing visitor_identifier row.  Confidence is computed as a weighted sum
 * of the signals provided and stored on the row.
 *
 * Auth: X-API-Key header matched against the tenant row in Postgres.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import {
  getPool,
  linkVisitorIdentity,
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
  let body: LinkPayload;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { visitor_id, email, cart_id, customer_id, shopify_shop } = body;

  if (!visitor_id) {
    return json({ error: "visitor_id is required" }, { status: 400 });
  }
  if (!email && !cart_id && !customer_id) {
    return json(
      { error: "At least one of email, cart_id, or customer_id is required" },
      { status: 400 }
    );
  }

  // ── Ensure row exists ─────────────────────────────────────────────────────
  await upsertVisitorIdentifier(tenantId, visitor_id);

  // ── Link identity signals with confidence scoring ─────────────────────────
  const { row, confidence } = await linkVisitorIdentity(tenantId, visitor_id, {
    email: email ?? null,
    cartId: cart_id ?? null,
    customerId: customer_id ?? null,
    shopifyShop: shopify_shop ?? null,
  });

  return json(
    {
      ok: true,
      visitor_id,
      tenant_id: tenantId,
      confidence,
      linked: {
        email: row.email,
        cart_id: row.cart_id,
        customer_id: row.customer_id,
        shopify_shop: row.shopify_shop,
      },
    },
    { status: 200 }
  );
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface LinkPayload {
  visitor_id: string;
  email?: string;
  cart_id?: string;
  customer_id?: string;
  shopify_shop?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveTenantByApiKey(apiKey: string): Promise<string | null> {
  if (!apiKey) return null;
  const db = getPool();
  const res = await db.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM tenant WHERE api_key = $1 LIMIT 1`,
    [apiKey]
  );
  return res.rows[0]?.tenant_id ?? null;
}
