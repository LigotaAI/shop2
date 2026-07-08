import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import type { Session } from "@shopify/shopify-api";
import { SQLiteSessionStorage } from "@shopify/shopify-app-session-storage-sqlite";
import { PgSessionStorage } from "./pg-session-storage.server";
import { ensureShopTenantTable, getShopTenant, upsertShopTenant } from "~/db.server";

const appSessionStorage =
  process.env.NODE_ENV !== "production"
    ? new SQLiteSessionStorage("./sessions.db")
    : new PgSessionStorage();

// ── Storefront widget injection ───────────────────────────────────────────────

const SNIPPET_MARKER = "<!-- leonix-fraud-engine -->";
const SNIPPET_END = "<!-- /leonix-fraud-engine -->";
const FPJS_PUBLIC_KEY = process.env.FPJS_PUBLIC_KEY || "lybk8D8ZmpCZhhwO8gvZ";
const API_VERSION = "2024-10";

const FPJS_PROXY = "https://cdn.leonix.io/fpjs";

function buildFpjsSnippet(): string {
  return `${SNIPPET_MARKER}
<script>
  (function(){
    import("${FPJS_PROXY}/v3/${FPJS_PUBLIC_KEY}")
      .then(function(M){ return M.load({ region:"ap", endpoint:"${FPJS_PROXY}" }); })
      .then(function(fp){ return fp.get(); })
      .then(function(r){
        fetch("/cart/update.js",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({attributes:{_leonix_request_id:r.requestId}})
        });
      })
      .catch(function(e){ console.debug("[leonix]",e); });
  })();
</script>
${SNIPPET_END}`;
}

export async function injectStorefrontWidget(session: Session): Promise<void> {
  const { shop, accessToken } = session;
  console.log(`[inject] called for shop=${shop} hasToken=${!!accessToken}`);
  if (!accessToken) return;

  const base = `https://${shop}/admin/api/${API_VERSION}`;
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };

  // 1. Get active theme
  const themesRes = await fetch(`${base}/themes.json`, { headers });
  const themesData = (await themesRes.json()) as {
    themes?: Array<{ id: number; role: string }>;
  };
  const mainTheme = themesData.themes?.find((t) => t.role === "main");
  if (!mainTheme) {
    console.warn(`[afterAuth] No main theme for shop=${shop}`);
    return;
  }

  // 2. Get layout/theme.liquid
  const assetUrl = `${base}/themes/${mainTheme.id}/assets.json?asset%5Bkey%5D=layout%2Ftheme.liquid`;
  const assetRes = await fetch(assetUrl, { headers });
  const assetData = (await assetRes.json()) as { asset?: { value?: string } };
  const current = assetData.asset?.value ?? "";

  // 3. Strip any existing snippet (handles stale/broken versions), then re-inject
  const stripped = current.replace(
    new RegExp(`${SNIPPET_MARKER}[\\s\\S]*?${SNIPPET_END}\\n?`, "g"),
    ""
  );
  const updated = stripped.replace("</body>", `${buildFpjsSnippet()}\n</body>`);
  if (updated === stripped) {
    console.warn(`[afterAuth] </body> not found in theme.liquid shop=${shop}`);
    return;
  }

  // 4. Save updated asset
  await fetch(`${base}/themes/${mainTheme.id}/assets.json`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ asset: { key: "layout/theme.liquid", value: updated } }),
  });
  console.info(`[afterAuth] Injected storefront widget for shop=${shop}`);
}

// ── Tenant auto-provisioning ──────────────────────────────────────────────────

const FRAUD_API_BASE = process.env.FRAUD_API_BASE_URL || "";
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "";

export async function provisionTenantForShop(shop: string): Promise<void> {
  if (!FRAUD_API_BASE || !INTERNAL_SECRET) {
    console.warn(`[provision] FRAUD_API_BASE_URL or INTERNAL_SECRET not set — skipping`);
    return;
  }

  await ensureShopTenantTable();

  const existing = await getShopTenant(shop);
  if (existing) {
    console.info(`[provision] shop=${shop} already mapped to tenant=${existing.tenant_id}`);
    return;
  }

  const tenantName = `shopify:${shop}`;
  const res = await fetch(`${FRAUD_API_BASE}/api/v1/internal/provision-tenant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_SECRET,
    },
    body: JSON.stringify({ shopify_shop: shop, tenant_name: tenantName, max_calls: 10000 }),
  });

  if (!res.ok) {
    throw new Error(`[provision] fraud engine returned ${res.status} for shop=${shop}`);
  }

  const data = (await res.json()) as { tenant_id: string; api_key: string; tenant_name: string };
  await upsertShopTenant({ shopify_shop: shop, tenant_id: data.tenant_id, api_key: data.api_key, tenant_name: data.tenant_name });
  console.info(`[provision] provisioned tenant=${data.tenant_id} for shop=${shop} (existed=${(data as any).already_existed})`);
}

// ─────────────────────────────────────────────────────────────────────────────

export const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October24,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: appSessionStorage,
  distribution: AppDistribution.AppStore,
  isEmbeddedApp: true,
  hooks: {
    afterAuth: async ({ session }) => {
      await shopify.registerWebhooks({ session });
      await provisionTenantForShop(session.shop).catch((err) =>
        console.error(`[afterAuth] tenant provision failed shop=${session.shop}:`, err)
      );
      await injectStorefrontWidget(session).catch((err) =>
        console.error(`[afterAuth] theme injection failed shop=${session.shop}:`, err)
      );
    },
  },
  future: {},
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October24;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
