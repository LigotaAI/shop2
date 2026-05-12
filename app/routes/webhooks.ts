/**
 * Shopify webhook receiver
 *
 * Handles:
 *   orders/create   → full scoring + action pipeline
 *   orders/updated  → update existing order_link with latest raw payload
 *   refunds/create  → log refund against order_link
 *
 * Shopify delivers webhooks with an HMAC-SHA256 signature in the
 * X-Shopify-Hmac-Sha256 header.  The `shopify.authenticate.webhook`
 * helper verifies this automatically; an InvalidHmacError is thrown and
 * converted to a 401 if the signature is wrong.
 *
 * Processing is async (fire-and-forget from Shopify's perspective): we
 * respond 200 immediately and do the heavy work in the background so
 * Shopify does not retry due to slow handlers.
 */

import { type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import {
  getPool,
  resolveVisitorBySignals,
  upsertOrderLink,
  updateOrderLinkDecision,
  updateOrderLinkAction,
} from "~/db.server";
import {
  normalizeShopifyOrder,
  buildScoringPayload,
  callFraudScore,
} from "~/services/scoring.server";
import {
  executeDecision,
  type Decision,
} from "~/services/shopify-actions.server";
import crypto from "node:crypto";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload, admin } =
    await authenticate.webhook(request);

  console.info(`[webhook] topic=${topic} shop=${shop}`);

  switch (topic) {
    case "ORDERS_CREATE":
      // Fire-and-forget; respond 200 fast
      void handleOrderCreate(shop, payload as Record<string, unknown>, admin).catch(
        (err) =>
          console.error(`[webhook] ORDERS_CREATE error shop=${shop}: ${err}`)
      );
      break;

    case "ORDERS_UPDATED":
      void handleOrderUpdated(shop, payload as Record<string, unknown>).catch(
        (err) =>
          console.error(`[webhook] ORDERS_UPDATED error shop=${shop}: ${err}`)
      );
      break;

    case "REFUNDS_CREATE":
      void handleRefundCreate(shop, payload as Record<string, unknown>).catch(
        (err) =>
          console.error(`[webhook] REFUNDS_CREATE error shop=${shop}: ${err}`)
      );
      break;

    default:
      console.warn(`[webhook] Unhandled topic: ${topic}`);
  }

  return new Response(null, { status: 200 });
};

// ── orders/create pipeline ────────────────────────────────────────────────────

async function handleOrderCreate(
  shop: string,
  rawOrder: Record<string, unknown>,
  admin: Awaited<ReturnType<typeof authenticate.webhook>>["admin"]
) {
  const order = normalizeShopifyOrder({ ...rawOrder, shop_domain: shop });
  const orderId = order.orderId;
  const idempotencyKey = `${shop}:order:${orderId}`;

  // ── Resolve tenant by shop domain ───────────────────────────────────────
  const tenantId = await resolveTenantByShop(shop);
  if (!tenantId) {
    console.warn(`[webhook] No tenant mapped to shop=${shop}`);
    return;
  }

  // ── Resolve visitor from order signals ──────────────────────────────────
  const { row: visitor, confidence: joinConf } = await resolveVisitorBySignals(
    tenantId,
    {
      email: order.email,
      cartId: order.cartToken,
      customerId: order.userId,
      shopifyShop: shop,
    }
  );

  // ── Upsert order_link (idempotent) ──────────────────────────────────────
  const orderLink = await upsertOrderLink({
    tenantId,
    shopifyOrderId: orderId,
    shopifyShop: shop,
    visitorIdentifierId: visitor?.id ?? null,
    joinConfidence: joinConf,
    rawOrder,
    idempotencyKey,
  });

  // If we already scored this order, skip re-scoring
  if (orderLink.decision) {
    console.info(`[webhook] order ${orderId} already scored, skipping`);
    return;
  }

  // ── Build scoring payload ────────────────────────────────────────────────
  const requestId = crypto.randomUUID();
  const scoringPayload = buildScoringPayload(order, visitor, requestId);

  // ── Call FastAPI /api/v1/score ───────────────────────────────────────────
  let scoreResult;
  try {
    scoreResult = await callFraudScore(scoringPayload);
  } catch (err) {
    console.error(`[webhook] scoring failed for order ${orderId}: ${err}`);
    await updateOrderLinkAction(orderLink.id, "failed", String(err));
    return;
  }

  // ── Persist decision ─────────────────────────────────────────────────────
  await updateOrderLinkDecision(
    orderLink.id,
    scoreResult.risk_score,
    scoreResult.decision,
    scoreResult.reasons
  );

  // ── Apply Shopify action ─────────────────────────────────────────────────
  if (!admin) {
    console.warn(`[webhook] No admin session available for shop=${shop}, skipping action`);
    await updateOrderLinkAction(orderLink.id, "skipped", "No admin session");
    return;
  }

  await executeDecision(
    admin,
    orderLink.id,
    orderId,
    scoreResult.decision as Decision
  );

  console.info(
    `[webhook] order=${orderId} score=${scoreResult.risk_score} decision=${scoreResult.decision}`
  );
}

// ── orders/updated ────────────────────────────────────────────────────────────

async function handleOrderUpdated(
  shop: string,
  rawOrder: Record<string, unknown>
) {
  const orderId = String(rawOrder.id ?? "");
  if (!orderId) return;

  const db = getPool();
  await db.query(
    `UPDATE order_link
        SET raw_order = $3, updated_at = now()
      WHERE shopify_order_id = $1 AND shopify_shop = $2`,
    [orderId, shop, JSON.stringify(rawOrder)]
  );
}

// ── refunds/create ────────────────────────────────────────────────────────────

async function handleRefundCreate(
  shop: string,
  rawRefund: Record<string, unknown>
) {
  const orderId = String(
    (rawRefund.order_id as number | string | undefined) ?? ""
  );
  if (!orderId) return;

  const db = getPool();
  await db.query(
    `UPDATE order_link
        SET action_detail = CONCAT(COALESCE(action_detail,''), $3),
            updated_at = now()
      WHERE shopify_order_id = $1 AND shopify_shop = $2`,
    [orderId, shop, ` | refund_id:${rawRefund.id}`]
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveTenantByShop(shop: string): Promise<string | null> {
  const db = getPool();
  // Tenant<->shop mapping stored in shopify_sessions table managed by the
  // session storage library (keyed by shop domain).  We fall back to looking
  // up the tenant by the shop domain stored on visitor_identifier rows.
  const res = await db.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM visitor_identifier
      WHERE shopify_shop = $1
      ORDER BY last_seen DESC NULLS LAST
      LIMIT 1`,
    [shop]
  );
  return res.rows[0]?.tenant_id ?? null;
}
