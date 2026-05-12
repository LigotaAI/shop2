/**
 * Fraud Engine Dashboard
 *
 * Displays the 50 most recent order scoring decisions for the authenticated
 * merchant, plus a simple webhook health indicator.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Badge,
  Text,
  BlockStack,
  InlineStack,
  Box,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { getPool, getRecentOrderLinks, type OrderLinkRow } from "~/db.server";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Resolve tenant by shop
  const db = getPool();
  const tenantRes = await db.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM visitor_identifier
      WHERE shopify_shop = $1
      ORDER BY last_seen DESC NULLS LAST LIMIT 1`,
    [shop]
  );
  const tenantId = tenantRes.rows[0]?.tenant_id ?? null;

  let recentOrders: OrderLinkRow[] = [];
  let webhookHealth: "ok" | "no_data" = "no_data";

  if (tenantId) {
    recentOrders = await getRecentOrderLinks(tenantId, 50);
    if (recentOrders.length > 0) webhookHealth = "ok";
  }

  // Stats summary
  const stats = {
    total: recentOrders.length,
    allow: recentOrders.filter((r) => r.decision === "allow").length,
    review: recentOrders.filter((r) => r.decision === "review").length,
    block: recentOrders.filter((r) => r.decision === "block").length,
    pending: recentOrders.filter((r) => !r.decision).length,
  };

  return json({ recentOrders, stats, webhookHealth, shop });
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function Index() {
  const { recentOrders, stats, webhookHealth, shop } =
    useLoaderData<typeof loader>();

  const rows = recentOrders.map((order) => [
    order.shopify_order_id,
    <DecisionBadge key={order.id} decision={order.decision} />,
    order.score != null ? `${(order.score).toFixed(1)}` : "—",
    <ActionBadge key={order.id} status={order.action_status} />,
    order.join_confidence != null
      ? `${(order.join_confidence * 100).toFixed(0)}%`
      : "—",
    order.created_at
      ? new Date(order.created_at).toLocaleString()
      : "—",
  ]);

  return (
    <Page title="Fraud Engine" subtitle={`Store: ${shop}`}>
      <Layout>
        {/* Webhook health */}
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">
                  Webhook Status
                </Text>
                <Badge tone={webhookHealth === "ok" ? "success" : "attention"}>
                  {webhookHealth === "ok" ? "Receiving" : "No data yet"}
                </Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                orders/create · orders/updated · refunds/create
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Stats row */}
        <Layout.Section>
          <InlineStack gap="400" wrap>
            <StatCard label="Total Scored" value={stats.total} />
            <StatCard label="Allow" value={stats.allow} tone="success" />
            <StatCard label="Review" value={stats.review} tone="warning" />
            <StatCard label="Block" value={stats.block} tone="critical" />
            <StatCard label="Pending" value={stats.pending} />
          </InlineStack>
        </Layout.Section>

        {/* Recent decisions table */}
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">
                Recent Fraud Decisions
              </Text>
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "numeric",
                  "text",
                  "numeric",
                  "text",
                ]}
                headings={[
                  "Order ID",
                  "Decision",
                  "Risk Score",
                  "Action",
                  "Join Confidence",
                  "Created",
                ]}
                rows={rows}
                defaultSortDirection="descending"
                initialSortColumnIndex={5}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return <Badge>Pending</Badge>;
  const tones: Record<string, "success" | "warning" | "critical" | undefined> =
    { allow: "success", review: "warning", block: "critical" };
  return <Badge tone={tones[decision]}>{decision}</Badge>;
}

function ActionBadge({ status }: { status: string | null }) {
  if (!status) return <Badge>—</Badge>;
  const tones: Record<string, "success" | "warning" | "critical" | undefined> =
    { done: "success", failed: "critical", skipped: "warning" };
  return <Badge tone={tones[status]}>{status}</Badge>;
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning" | "critical";
}) {
  return (
    <Box
      background="bg-surface"
      borderRadius="200"
      padding="400"
      minWidth="120px"
    >
      <BlockStack gap="100" align="center">
        <Text variant="headingLg" as="p" tone={tone}>
          {value}
        </Text>
        <Text as="p" tone="subdued" variant="bodyMd">
          {label}
        </Text>
      </BlockStack>
    </Box>
  );
}
