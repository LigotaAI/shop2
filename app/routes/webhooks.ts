/**
 * Shopify webhook receiver
 *
 * Handles:
 *   orders/create   -> full scoring + action pipeline
 *   orders/updated  -> update existing order_link with latest raw payload
 *   refunds/create  -> log refund against order_link
 */

import { type ActionFunctionArgs } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import {
  getPool,
  getShopTenant,
  resolveVisitorBySignals,
  upsertOrderLink,
  updateOrderLinkDecision,
  updateOrderLinkAction,
} from '~/db.server';
import {
  normalizeShopifyOrder,
  callFraudScore,
} from '~/services/scoring.server';
import {
  executeDecision,
  type Decision,
} from '~/services/shopify-actions.server';

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } =
    await authenticate.webhook(request);

  console.info(`[webhook] topic=${topic} shop=${shop}`);

  switch (topic) {
    case 'ORDERS_CREATE':
      void handleOrderCreate(shop, payload as Record<string, unknown>, admin).catch(
        (err) => console.error(`[webhook] ORDERS_CREATE error shop=${shop}: ${err}`)
      );
      break;

    case 'ORDERS_UPDATED':
      void handleOrderUpdated(shop, payload as Record<string, unknown>).catch(
        (err) => console.error(`[webhook] ORDERS_UPDATED error shop=${shop}: ${err}`)
      );
      break;

    case 'REFUNDS_CREATE':
      void handleRefundCreate(shop, payload as Record<string, unknown>).catch(
        (err) => console.error(`[webhook] REFUNDS_CREATE error shop=${shop}: ${err}`)
      );
      break;

    // ── GDPR mandatory webhooks ────────────────────────────────────────────────
    case 'CUSTOMERS_DATA_REQUEST':
      // We don't store PII beyond email/customer_id linked to visitor_identifier.
      // Acknowledge receipt — no data export required for our use case.
      console.info(`[webhook] CUSTOMERS_DATA_REQUEST shop=${shop} acknowledged`);
      break;

    case 'CUSTOMERS_REDACT':
      void handleCustomersRedact(shop, payload as Record<string, unknown>).catch(
        (err) => console.error(`[webhook] CUSTOMERS_REDACT error shop=${shop}: ${err}`)
      );
      break;

    case 'SHOP_REDACT':
      void handleShopRedact(shop).catch(
        (err) => console.error(`[webhook] SHOP_REDACT error shop=${shop}: ${err}`)
      );
      break;

    case 'APP_UNINSTALLED':
      void handleAppUninstalled(shop).catch(
        (err) => console.error(`[webhook] APP_UNINSTALLED error shop=${shop}: ${err}`)
      );
      break;

    default:
      console.warn(`[webhook] Unhandled topic: ${topic}`);
  }

  return new Response(null, { status: 200 });
};

// -- orders/create pipeline ---------------------------------------------------

async function handleOrderCreate(
  shop: string,
  rawOrder: Record<string, unknown>,
  admin: Awaited<ReturnType<typeof authenticate.webhook>>['admin']
) {
  const order   = normalizeShopifyOrder({ ...rawOrder, shop_domain: shop });
  const orderId = order.orderId;
  const idempotencyKey = `${shop}:order:${orderId}`;

  const tenantId = await resolveTenantByShop(shop);
  if (!tenantId) {
    console.warn(`[webhook] No tenant mapped to shop=${shop}`);
    return;
  }

  const { row: visitor, confidence: joinConf } = await resolveVisitorBySignals(
    tenantId,
    {
      email:       order.email,
      cartId:      order.cartToken,
      customerId:  order.userId,
      shopifyShop: shop,
    }
  );

  const orderLink = await upsertOrderLink({
    tenantId,
    shopifyOrderId:      orderId,
    shopifyShop:         shop,
    visitorIdentifierId: visitor?.id ?? null,
    joinConfidence:      joinConf,
    rawOrder,
    idempotencyKey,
  });

  if (orderLink.decision) {
    console.info(`[webhook] order ${orderId} already scored, skipping`);
    return;
  }

  let scoreResult;
  try {
    scoreResult = await callFraudScore(order);
  } catch (err) {
    console.error(`[webhook] scoring failed for order ${orderId}: ${err}`);
    await updateOrderLinkAction(orderLink.id, 'failed', String(err));
    return;
  }

  await updateOrderLinkDecision(
    orderLink.id,
    scoreResult.risk_score,
    scoreResult.decision,
    scoreResult.reasons,
    scoreResult.request_id
  );

  if (!admin) {
    console.warn(`[webhook] No admin session for shop=${shop}, skipping action`);
    await updateOrderLinkAction(orderLink.id, 'skipped', 'No admin session');
    return;
  }

  await executeDecision(admin, orderLink.id, orderId, scoreResult.decision as Decision);

  console.info(
    `[webhook] order=${orderId} score=${scoreResult.risk_score} decision=${scoreResult.decision}`
  );
}

// -- orders/updated -----------------------------------------------------------

async function handleOrderUpdated(shop: string, rawOrder: Record<string, unknown>) {
  const orderId = String(rawOrder.id ?? '');
  if (!orderId) return;

  const db = getPool();
  await db.query(
    `UPDATE order_link
        SET raw_order = $3, updated_at = now()
      WHERE shopify_order_id = $1 AND shopify_shop = $2`,
    [orderId, shop, JSON.stringify(rawOrder)]
  );
}

// -- refunds/create -----------------------------------------------------------

async function handleRefundCreate(shop: string, rawRefund: Record<string, unknown>) {
  const orderId = String((rawRefund.order_id as number | string | undefined) ?? '');
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

// -- Helpers ------------------------------------------------------------------

// -- GDPR: customers/redact ---------------------------------------------------

async function handleCustomersRedact(
  shop: string,
  payload: Record<string, unknown>
) {
  const db = getPool();
  const email = (payload.customer as Record<string, unknown>)?.email as string | undefined;
  const customerId = String(
    (payload.customer as Record<string, unknown>)?.id ?? ''
  );

  // Delete visitor_identifier rows tied to this customer on this shop
  if (email) {
    await db.query(
      `DELETE FROM visitor_identifier WHERE shopify_shop = $1 AND email = $2`,
      [shop, email]
    );
  }
  if (customerId) {
    await db.query(
      `DELETE FROM visitor_identifier WHERE shopify_shop = $1 AND customer_id = $2`,
      [shop, customerId]
    );
  }

  // Redact PII from order_link rows for this shop + customer
  const orderIds = (payload.orders_to_redact as Array<{ id: number }> | undefined)
    ?.map((o) => String(o.id)) ?? [];
  if (orderIds.length) {
    await db.query(
      `UPDATE order_link
          SET raw_order = NULL
        WHERE shopify_shop = $1 AND shopify_order_id = ANY($2::text[])`,
      [shop, orderIds]
    );
  }

  console.info(`[webhook] CUSTOMERS_REDACT done shop=${shop} email=${email}`);
}

// -- GDPR: shop/redact --------------------------------------------------------

async function handleShopRedact(shop: string) {
  const db = getPool();

  // Delete all order data for this shop (48h grace period has passed per Shopify)
  await db.query(`DELETE FROM order_link WHERE shopify_shop = $1`, [shop]);
  await db.query(`DELETE FROM visitor_identifier WHERE shopify_shop = $1`, [shop]);

  console.info(`[webhook] SHOP_REDACT done shop=${shop}`);
}

// -- app/uninstalled ----------------------------------------------------------

async function handleAppUninstalled(shop: string) {
  // Sessions are cleaned up automatically by the session storage layer.
  // Log for audit trail — shop data is retained per GDPR grace period rules
  // until shop/redact fires (Shopify sends that 48h after uninstall).
  console.info(`[webhook] APP_UNINSTALLED shop=${shop}`);
}

// -- Helpers ------------------------------------------------------------------

async function resolveTenantByShop(shop: string): Promise<string | null> {
  // Primary: shop_tenants table (populated on install via afterAuth)
  const shopTenant = await getShopTenant(shop);
  if (shopTenant) return shopTenant.tenant_id;

  // Fallback: legacy visitor_identifier lookup (for pre-existing manual mappings)
  const db = getPool();
  const res = await db.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM visitor_identifier
      WHERE shopify_shop = $1
      ORDER BY last_seen DESC NULLS LAST
      LIMIT 1`,
    [shop]
  );
  return res.rows[0]?.tenant_id ?? null;
}
