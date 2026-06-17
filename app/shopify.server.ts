import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import type { Session } from "@shopify/shopify-api";
import { SQLiteSessionStorage } from "@shopify/shopify-app-session-storage-sqlite";
import { PgSessionStorage } from "./pg-session-storage.server";

const appSessionStorage =
  process.env.NODE_ENV !== "production"
    ? new SQLiteSessionStorage("./sessions.db")
    : new PgSessionStorage();

// ── Storefront widget injection ───────────────────────────────────────────────

const SNIPPET_MARKER = "<!-- leonix-fraud-engine -->";
const SNIPPET_END = "<!-- /leonix-fraud-engine -->";
const FPJS_PUBLIC_KEY = process.env.FPJS_PUBLIC_KEY || "lybk8D8ZmpCZhhwO8gvZ";
const API_VERSION = "2024-10";

function buildFpjsSnippet(): string {
  return `${SNIPPET_MARKER}
<script>
  (function(){
    import("https://fpjscdn.net/v3/${FPJS_PUBLIC_KEY}")
      .then(function(M){ return M.load({ region:"ap" }); })
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
