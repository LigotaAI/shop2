import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { getShopTenant } from "~/db.server";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { requestId } = params;

  if (!requestId) {
    return json({ error: "Missing request ID" }, { status: 400 });
  }

  const shopTenant = await getShopTenant(session.shop);
  const tenantKey = shopTenant?.api_key ?? process.env.FRAUD_API_KEY ?? "";

  try {
    const res = await fetch(
      `${process.env.FRAUD_API_BASE_URL}/api/v1/fp/logs/${requestId}`,
      { headers: { "X-Tenant-Key": tenantKey } }
    );
    if (!res.ok) {
      return json({ error: `Fraud engine returned ${res.status}` }, { status: res.status });
    }
    return json(await res.json());
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
