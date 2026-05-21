import { Outlet } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/node";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "~/shopify.server";
import { injectStorefrontWidget } from "~/shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("[app] loader called", request.url);
  const { session } = await authenticate.admin(request);
  console.log("[app] authenticated session.shop=", session?.shop);
  void injectStorefrontWidget(session).catch((err) =>
    console.error("[app] widget injection failed:", err)
  );
  return null;
};

export default function App() {
  return (
    <AppProvider isEmbeddedApp apiKey={process.env.SHOPIFY_API_KEY!}>
      <NavMenu>
        <a href="/app" rel="home">
          Dashboard
        </a>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}
