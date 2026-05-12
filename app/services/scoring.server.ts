/**
 * Scoring service
 *
 * Builds a unified payload from the Shopify order + resolved visitor/session
 * signals and forwards it to the existing FastAPI /api/v1/score endpoint.
 *
 * Implements:
 *   - retry with exponential back-off (max 3 attempts)
 *   - idempotency keyed by Shopify order ID
 *   - structured logging
 */

import type { OrderLinkRow, VisitorIdentifierRow } from "~/db.server";

const FRAUD_API_BASE = (process.env.FRAUD_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
const FRAUD_API_KEY = process.env.FRAUD_API_KEY ?? "";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

// ── Public types ──────────────────────────────────────────────────────────────

export interface ScoreResult {
  request_id: string;
  risk_score: number;
  decision: string;
  reasons: string[];
}

export interface NormalizedOrder {
  orderId: string;
  shopifyShop: string;
  email: string | null;
  phone: string | null;
  totalPrice: number;
  currency: string;
  ip: string | null;
  userId: string | null;
  cartToken: string | null;
  createdAt: string;
  billingAddress: Record<string, string> | null;
  shippingAddress: Record<string, string> | null;
  lineItems: Array<{ title: string; quantity: number; price: number }>;
  riskLevel: string | null;
}

// ── Normalize ─────────────────────────────────────────────────────────────────

export function normalizeShopifyOrder(
  raw: Record<string, unknown>
): NormalizedOrder {
  const billingAddr = raw.billing_address as Record<string, unknown> | null;
  const shippingAddr = raw.shipping_address as Record<string, unknown> | null;
  const lineItems = Array.isArray(raw.line_items) ? raw.line_items : [];
  const riskRec = Array.isArray(raw.risk_assessment)
    ? (raw.risk_assessment as Array<Record<string, unknown>>)[0]
    : null;

  return {
    orderId: String(raw.id ?? ""),
    shopifyShop: String(raw.shop_domain ?? ""),
    email: (raw.email as string | null) ?? null,
    phone: (raw.phone as string | null) ?? null,
    totalPrice: Number(raw.total_price ?? 0),
    currency: String(raw.currency ?? "USD"),
    ip: (raw.browser_ip as string | null) ?? null,
    userId: (raw.customer as Record<string, unknown> | null)?.id
      ? String((raw.customer as Record<string, unknown>).id)
      : null,
    cartToken: (raw.cart_token as string | null) ?? null,
    createdAt: String(raw.created_at ?? new Date().toISOString()),
    billingAddress: billingAddr
      ? (billingAddr as Record<string, string>)
      : null,
    shippingAddress: shippingAddr
      ? (shippingAddr as Record<string, string>)
      : null,
    lineItems: lineItems.map((item) => ({
      title: String((item as Record<string, unknown>).title ?? ""),
      quantity: Number((item as Record<string, unknown>).quantity ?? 1),
      price: Number((item as Record<string, unknown>).price ?? 0),
    })),
    riskLevel: riskRec ? String(riskRec.recommendation ?? "") : null,
  };
}

// ── Build scoring payload ─────────────────────────────────────────────────────

export function buildScoringPayload(
  order: NormalizedOrder,
  visitor: VisitorIdentifierRow | null,
  requestId: string
) {
  return {
    request_id: requestId,
    user_id: order.userId ?? visitor?.customer_id ?? "anonymous",
    email: order.email ?? visitor?.email ?? "unknown@example.com",
    ip: order.ip ?? visitor?.ip_address ?? "0.0.0.0",
    device: {
      visitor_id: visitor?.visitor_id ?? "unknown",
      confidence: visitor?.confidence ?? 0.0,
      vpn: false,
      proxy: false,
      tor: false,
      incognito: false,
      timezone_mismatch: false,
    },
    session: {
      attempted_at: order.createdAt,
      login: false,
      checkout: true,
      amount: order.totalPrice,
    },
    // Extended Shopify-specific context forwarded to the scoring engine
    shopify: {
      order_id: order.orderId,
      shop: order.shopifyShop,
      cart_token: order.cartToken,
      risk_level: order.riskLevel,
      total_price: order.totalPrice,
      currency: order.currency,
      line_item_count: order.lineItems.length,
      billing_country: order.billingAddress?.country_code ?? null,
      shipping_country: order.shippingAddress?.country_code ?? null,
      join_confidence: visitor?.confidence ?? 0.0,
    },
  };
}

// ── Call FastAPI /api/v1/score ────────────────────────────────────────────────

export async function callFraudScore(
  payload: ReturnType<typeof buildScoringPayload>
): Promise<ScoreResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${FRAUD_API_BASE}/api/v1/score`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": FRAUD_API_KEY,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Fraud API responded ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = (await res.json()) as ScoreResult;
      return data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[scoring] attempt ${attempt}/${MAX_RETRIES} failed for request_id=${payload.request_id}: ${lastError.message}`
      );
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError ?? new Error("Unknown scoring error");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
