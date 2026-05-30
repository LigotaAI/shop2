/**
 * Scoring service
 *
 * Calls the Leonix fraud engine GET /api/v1/fp/verify endpoint using the
 * FPJS request_id captured on the storefront and the customer email from
 * the Shopify order.
 *
 * Implements:
 *   - retry with exponential back-off (max 3 attempts)
 *   - graceful fallback when no _leonix_request_id present
 */

const FRAUD_API_BASE = (process.env.FRAUD_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");
const FRAUD_API_KEY  = process.env.FRAUD_API_KEY ?? "";
const MAX_RETRIES    = 3;
const BASE_DELAY_MS  = 500;

// ── Public types ──────────────────────────────────────────────────────────────

export interface ScoreResult {
  request_id:  string;
  risk_score:  number;
  decision:    string;
  reasons:     string[];
}

export interface NormalizedOrder {
  orderId:         string;
  shopifyShop:     string;
  email:           string | null;
  phone:           string | null;
  totalPrice:      number;
  currency:        string;
  ip:              string | null;
  userId:          string | null;
  cartToken:       string | null;
  leonixRequestId: string | null;
  createdAt:       string;
  billingAddress:  Record<string, string> | null;
  shippingAddress: Record<string, string> | null;
  lineItems:       Array<{ title: string; quantity: number; price: number }>;
  riskLevel:       string | null;
}

// ── Normalize ─────────────────────────────────────────────────────────────────

export function normalizeShopifyOrder(
  raw: Record<string, unknown>
): NormalizedOrder {
  const billingAddr  = raw.billing_address as Record<string, unknown> | null;
  const shippingAddr = raw.shipping_address as Record<string, unknown> | null;
  const lineItems    = Array.isArray(raw.line_items) ? raw.line_items : [];
  const riskRec      = Array.isArray(raw.risk_assessment)
    ? (raw.risk_assessment as Array<Record<string, unknown>>)[0]
    : null;

  const cartAttrs = Array.isArray(raw.cart_attributes)
    ? (raw.cart_attributes as Array<{ name: string; value: string }>)
    : [];
  const noteAttrs = Array.isArray(raw.note_attributes)
    ? (raw.note_attributes as Array<{ name: string; value: string }>)
    : [];
  const leonixAttr      = [...cartAttrs, ...noteAttrs].find((a) => a.name === "_leonix_request_id");
  const leonixRequestId = leonixAttr?.value ?? null;

  return {
    orderId:         String(raw.id ?? ""),
    shopifyShop:     String(raw.shop_domain ?? ""),
    email:           (raw.email as string | null) ?? null,
    phone:           (raw.phone as string | null) ?? null,
    totalPrice:      Number(raw.total_price ?? 0),
    currency:        String(raw.currency ?? "USD"),
    ip:              (raw.browser_ip as string | null) ?? null,
    userId:          (raw.customer as Record<string, unknown> | null)?.id
                       ? String((raw.customer as Record<string, unknown>).id)
                       : null,
    cartToken:       (raw.cart_token as string | null) ?? null,
    leonixRequestId,
    createdAt:       String(raw.created_at ?? new Date().toISOString()),
    billingAddress:  billingAddr  ? (billingAddr  as Record<string, string>) : null,
    shippingAddress: shippingAddr ? (shippingAddr as Record<string, string>) : null,
    lineItems:       lineItems.map((item) => ({
      title:    String((item as Record<string, unknown>).title    ?? ""),
      quantity: Number((item as Record<string, unknown>).quantity ?? 1),
      price:    Number((item as Record<string, unknown>).price    ?? 0),
    })),
    riskLevel: riskRec ? String(riskRec.recommendation ?? "") : null,
  };
}

// ── Call GET /api/v1/fp/verify ────────────────────────────────────────────────

export async function callFraudScore(
  order: NormalizedOrder
): Promise<ScoreResult> {
  if (!order.leonixRequestId) {
    console.warn("[scoring] No _leonix_request_id on order — returning default allow");
    return { request_id: "", risk_score: 0, decision: "allow", reasons: [] };
  }

  const email  = order.email ?? "unknown@example.com";
  const params = new URLSearchParams({
    fingure_print_request_id: order.leonixRequestId,
    email,
  });
  const url = `${FRAUD_API_BASE}/api/v1/fp/verify?${params}`;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "X-Tenant-Key": FRAUD_API_KEY },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Fraud API responded ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as ScoreResult;
      console.info(`[scoring] order=${order.orderId} score=${data.risk_score} decision=${data.decision}`);
      return data;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[scoring] attempt ${attempt}/${MAX_RETRIES} failed for order=${order.orderId}: ${lastError.message}`);
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
