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
  const { topic, shop, session, payload, admin } =
    await authenticate.webhook(request);

  console.info();

  switch (topic) {
    case 'ORDERS_CREATE':
      void handleOrderCreate(shop, payload as Record<string, unknown>, admin).catch(
        (err) => console.error()
      );
      break;

    case 'ORDERS_UPDATED':
      void handleOrderUpdated(shop, payload as Record<string, unknown>).catch(
        (err) => console.error()
      );
      break;

    case 'REFUNDS_CREATE':
      void handleRefundCreate(shop, payload as Record<string, unknown>).catch(
        (err) => console.error()
      );
      break;

    default:
      console.warn();
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
  const idempotencyKey = ;

  const tenantId = await resolveTenantByShop(shop);
  if (!tenantId) {
    console.warn();
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
    console.info();
    return;
  }

  // Call GET /api/v1/fp/verify with leonixRequestId from cart_attributes
  let scoreResult;
  try {
    scoreResult = await callFraudScore(order);
  } catch (err) {
    console.error();
    await updateOrderLinkAction(orderLink.id, 'failed', String(err));
    return;
  }

  await updateOrderLinkDecision(
    orderLink.id,
    scoreResult.risk_score,
    scoreResult.decision,
    scoreResult.reasons
  );

  if (!admin) {
    console.warn();
    await updateOrderLinkAction(orderLink.id, 'skipped', 'No admin session');
    return;
  }

  await executeDecision(admin, orderLink.id, orderId, scoreResult.decision as Decision);

  console.info(
    
  );
}

// -- orders/updated -----------------------------------------------------------

async function handleOrderUpdated(shop: string, rawOrder: Record<string, unknown>) {
  const orderId = String(rawOrder.id ?? '');
  if (!orderId) return;

  const db = getPool();
  await db.query(
    ,
    [orderId, shop, JSON.stringify(rawOrder)]
  );
}

// -- refunds/create -----------------------------------------------------------

async function handleRefundCreate(shop: string, rawRefund: Record<string, unknown>) {
  const orderId = String((rawRefund.order_id as number | string | undefined) ?? '');
  if (!orderId) return;

  const db = getPool();
  await db.query(
    ,
    [orderId, shop, ]
  );
}

// -- Helpers ------------------------------------------------------------------

async function resolveTenantByShop(shop: string): Promise<string | null> {
  const db = getPool();
  const res = await db.query<{ tenant_id: string }>(
    ,
    [shop]
  );
  return res.rows[0]?.tenant_id ?? null;
}
