import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

export async function action({ params, request }: ActionFunctionArgs) {
  await authenticate.admin(request);

  const body = await request.json();

  const res = await fetch(
    `${process.env.FRAUD_API_BASE_URL}/api/v1/fp/agent/${params.requestId}/chat`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tenant-Key": process.env.FRAUD_API_KEY!,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    return json(
      { error: `Fraud engine returned ${res.status}` },
      { status: res.status }
    );
  }

  return json(await res.json());
}
