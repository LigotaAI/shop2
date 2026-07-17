import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { getShopTenant } from "~/db.server";

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { requestId } = params;

  if (!requestId) {
    return json({ error: "Missing request ID" }, { status: 400 });
  }

  const shopTenant = await getShopTenant(session.shop);
  const tenantKey = shopTenant?.api_key ?? process.env.FRAUD_API_KEY ?? "";

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `${process.env.FRAUD_API_BASE_URL}/api/v1/fp/logs/${requestId}/outcome`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Tenant-Key": tenantKey,
        },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      return json({ error: `Fraud engine returned ${res.status}` }, { status: res.status });
    }
    return json(await res.json());
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
