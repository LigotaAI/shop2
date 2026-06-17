import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  const res = await fetch(
    `${process.env.FRAUD_API_BASE_URL}/api/v1/fp/logs/${params.requestId}`,
    { headers: { "X-Tenant-Key": process.env.FRAUD_API_KEY! } }
  );

  if (!res.ok) {
    return json(
      { error: `Fraud engine returned ${res.status}` },
      { status: res.status }
    );
  }

  return json(await res.json());
}
