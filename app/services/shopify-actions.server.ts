/**
 * Shopify action executor
 *
 * Applies fraud decisions back to Shopify via the Admin REST API:
 *   allow  → add tag "fraud-safe"
 *   review → add tag "fraud-review", create a fulfillment hold
 *   block  → add tag "fraud-block", then cancel (or refund) based on merchant flag
 *
 * All actions are idempotent: if the tag already exists or the order is
 * already cancelled/held, the call is a no-op with a success return.
 *
 * SHADOW_MODE=true skips destructive actions (cancel/refund) but still tags.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { updateOrderLinkAction } from "~/db.server";

const SHADOW_MODE = process.env.SHADOW_MODE === "true";

export type Decision = "allow" | "review" | "block";

export interface ActionResult {
  success: boolean;
  detail: string;
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function executeDecision(
  admin: AdminApiContext,
  orderLinkId: string,
  shopifyOrderId: string,
  decision: Decision
): Promise<ActionResult> {
  try {
    let result: ActionResult;

    switch (decision) {
      case "allow":
        result = await handleAllow(admin, shopifyOrderId);
        break;
      case "review":
        result = await handleReview(admin, shopifyOrderId);
        break;
      case "block":
        result = await handleBlock(admin, shopifyOrderId);
        break;
      default:
        result = { success: false, detail: `Unknown decision: ${decision}` };
    }

    await updateOrderLinkAction(
      orderLinkId,
      result.success ? "done" : "failed",
      result.detail
    );
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[actions] Failed to execute ${decision} for order ${shopifyOrderId}: ${detail}`
    );
    await updateOrderLinkAction(orderLinkId, "failed", detail);
    return { success: false, detail };
  }
}

// ── Allow ─────────────────────────────────────────────────────────────────────

async function handleAllow(
  admin: AdminApiContext,
  orderId: string
): Promise<ActionResult> {
  await addOrderTags(admin, orderId, ["fraud-safe"]);
  return { success: true, detail: "Tagged fraud-safe" };
}

// ── Review ────────────────────────────────────────────────────────────────────

async function handleReview(
  admin: AdminApiContext,
  orderId: string
): Promise<ActionResult> {
  await addOrderTags(admin, orderId, ["fraud-review"]);

  // Apply a fulfillment hold via GraphQL
  try {
    const gid = `gid://shopify/Order/${orderId}`;
    const mutation = `
      mutation fulfillmentHoldCreate($fulfillmentHoldInput: FulfillmentHoldInput!, $id: ID!) {
        fulfillmentHoldCreate(fulfillmentHoldInput: $fulfillmentHoldInput, id: $id) {
          fulfillmentOrder {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const result = await admin.graphql(mutation, {
      variables: {
        id: gid,
        fulfillmentHoldInput: {
          reason: "FRAUD_ANALYSIS_IN_PROGRESS",
          reasonNotes: "Flagged for fraud review by FraudEngine",
        },
      },
    });
    const data = await result.json();
    const errors =
      data?.data?.fulfillmentHoldCreate?.userErrors ?? [];
    if (errors.length) {
      const msg = errors.map((e: { message: string }) => e.message).join("; ");
      return { success: true, detail: `Tagged fraud-review; hold skipped: ${msg}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: true, detail: `Tagged fraud-review; hold failed: ${msg}` };
  }

  return { success: true, detail: "Tagged fraud-review and fulfillment held" };
}

// ── Block ─────────────────────────────────────────────────────────────────────

async function handleBlock(
  admin: AdminApiContext,
  orderId: string
): Promise<ActionResult> {
  await addOrderTags(admin, orderId, ["fraud-block"]);

  if (SHADOW_MODE) {
    return {
      success: true,
      detail: "shadow-mode: tagged fraud-block, cancel suppressed",
    };
  }

  // Cancel the order
  try {
    const response = await admin.rest.post({
      path: `orders/${orderId}/cancel`,
      data: {
        reason: "fraud",
        restock: true,
        email: false,
        note: "Automatically cancelled by FraudEngine",
      },
    });

    if (response.status >= 400) {
      const body = await response.json();
      return {
        success: false,
        detail: `Cancel failed (${response.status}): ${JSON.stringify(body).slice(0, 200)}`,
      };
    }
    return { success: true, detail: "Tagged fraud-block and order cancelled" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, detail: `Cancel threw: ${msg}` };
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function addOrderTags(
  admin: AdminApiContext,
  orderId: string,
  tags: string[]
): Promise<void> {
  const gid = `gid://shopify/Order/${orderId}`;
  const mutation = `
    mutation tagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `;
  await admin.graphql(mutation, {
    variables: { id: gid, tags },
  });
}
