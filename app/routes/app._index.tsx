import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Badge,
  Text,
  BlockStack,
  InlineStack,
  Box,
  Button,
  Collapsible,
  Spinner,
  TextField,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { getShopTenant, getPool, getRecentOrderLinks, type OrderLinkRow } from "~/db.server";

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Primary: shop_tenants (auto-provisioned on install)
  let tenantId: string | null = null;
  const shopTenant = await getShopTenant(shop);
  if (shopTenant) {
    tenantId = shopTenant.tenant_id;
  } else {
    // Fallback: legacy visitor_identifier lookup for manually mapped shops
    const db = getPool();
    const tenantRes = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM visitor_identifier
        WHERE shopify_shop = $1
        ORDER BY last_seen DESC NULLS LAST LIMIT 1`,
      [shop]
    );
    tenantId = tenantRes.rows[0]?.tenant_id ?? null;
  }

  let recentOrders: OrderLinkRow[] = [];
  let webhookHealth: "ok" | "no_data" = "no_data";

  if (tenantId) {
    recentOrders = await getRecentOrderLinks(tenantId, 50);
    if (recentOrders.length > 0) webhookHealth = "ok";
  }

  const stats = {
    total: recentOrders.length,
    allow: recentOrders.filter((r) => r.decision === "allow").length,
    review: recentOrders.filter((r) => r.decision === "review").length,
    block: recentOrders.filter((r) => r.decision === "block").length,
    pending: recentOrders.filter((r) => !r.decision).length,
  };

  return json({ recentOrders, stats, webhookHealth, shop });
};

// ── Root component ─────────────────────────────────────────────────────────────

export default function Index() {
  const { recentOrders, stats, webhookHealth, shop } =
    useLoaderData<typeof loader>();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <Page title="FraudSentry" subtitle={`Store: ${shop}`}>
      <Layout>
        {/* Webhook health */}
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">Webhook Status</Text>
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

        {/* Stats */}
        <Layout.Section>
          <InlineStack gap="400" wrap>
            <StatCard label="Total Scored" value={stats.total} />
            <StatCard label="Allow" value={stats.allow} tone="success" />
            <StatCard label="Review" value={stats.review} tone="caution" />
            <StatCard label="Block" value={stats.block} tone="critical" />
            <StatCard label="Pending" value={stats.pending} />
          </InlineStack>
        </Layout.Section>

        {/* Order list */}
        <Layout.Section>
          <Card padding="0">
            <Box padding="400">
              <Text variant="headingMd" as="h2">Recent Fraud Decisions</Text>
            </Box>
            {recentOrders.length === 0 ? (
              <Box padding="400">
                <Text as="p" tone="subdued">No orders scored yet.</Text>
              </Box>
            ) : (
              recentOrders.map((order, idx) => (
                <div key={order.id}>
                  {idx > 0 && <Divider />}
                  <OrderRow
                    order={order}
                    expanded={expandedId === order.id}
                    onToggle={() =>
                      setExpandedId(expandedId === order.id ? null : order.id)
                    }
                  />
                </div>
              ))
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ── OrderRow ───────────────────────────────────────────────────────────────────

type SerializedOrderLinkRow = Omit<OrderLinkRow, "created_at" | "updated_at"> & {
  created_at: string;
  updated_at: string | null;
};

function OrderRow({
  order,
  expanded,
  onToggle,
}: {
  order: SerializedOrderLinkRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const detailFetcher = useFetcher<any>();

  useEffect(() => {
    if (
      expanded &&
      order.fraud_request_id &&
      detailFetcher.state === "idle" &&
      !detailFetcher.data
    ) {
      detailFetcher.load(`/app/order-detail/${order.fraud_request_id}`);
    }
  }, [expanded]);

  return (
    <Box>
      <Box padding="400">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <InlineStack gap="400" blockAlign="center" wrap>
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              #{order.shopify_order_id}
            </Text>
            <DecisionBadge decision={order.decision} />
            <Text as="span" tone="subdued" variant="bodySm">
              Risk: {order.score != null ? order.score.toFixed(2) : "—"}
            </Text>
            <ActionBadge status={order.action_status} />
            <Text as="span" tone="subdued" variant="bodySm">
              {order.created_at
                ? new Date(order.created_at).toLocaleString()
                : "—"}
            </Text>
          </InlineStack>
          {order.fraud_request_id ? (
            <Button
              size="slim"
              onClick={onToggle}
              disclosure={expanded ? "up" : "down"}
            >
              {expanded ? "Hide" : "Details"}
            </Button>
          ) : (
            <Text as="span" tone="subdued" variant="bodySm">
              No details
            </Text>
          )}
        </InlineStack>
      </Box>

      <Collapsible open={expanded} id={`order-${order.id}`}>
        <Box paddingInlineStart="400" paddingInlineEnd="400" paddingBlockEnd="500">
          <Divider />
          <Box paddingBlockStart="400">
            {detailFetcher.state === "loading" && (
              <InlineStack align="center">
                <Spinner size="small" />
              </InlineStack>
            )}
            {detailFetcher.data?.error && (
              <Text as="p" tone="critical">{detailFetcher.data.error}</Text>
            )}
            {detailFetcher.data && !detailFetcher.data.error && (
              <EventDetailPanel
                data={detailFetcher.data}
                fraudRequestId={order.fraud_request_id!}
              />
            )}
          </Box>
        </Box>
      </Collapsible>
    </Box>
  );
}

// ── EventDetailPanel ───────────────────────────────────────────────────────────

function OutcomeButtons({ fraudRequestId }: { fraudRequestId: string }) {
  const fetcher = useFetcher<any>();
  const [outcome, setOutcome] = useState<string | null>(null);
  const isLoading = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.outcome) setOutcome(fetcher.data.outcome);
  }, [fetcher.data]);

  const submit = (value: string) => {
    fetcher.submit(
      { outcome: value },
      {
        method: "POST",
        action: `/app/set-outcome/${fraudRequestId}`,
        encType: "application/json",
      }
    );
  };

  if (outcome === "confirmed_fraud") {
    return <Badge tone="critical">Confirmed Fraud</Badge>;
  }
  if (outcome === "false_positive") {
    return <Badge tone="success">Marked Legitimate</Badge>;
  }

  return (
    <InlineStack gap="200">
      <Button
        tone="critical"
        variant="primary"
        size="slim"
        loading={isLoading}
        onClick={() => submit("confirmed_fraud")}
      >
        Confirm Fraud
      </Button>
      <Button
        size="slim"
        loading={isLoading}
        onClick={() => submit("false_positive")}
      >
        Mark Legitimate
      </Button>
    </InlineStack>
  );
}

function EventDetailPanel({
  data,
  fraudRequestId,
}: {
  data: any;
  fraudRequestId: string;
}) {
  const ci = data.customer_info;
  const agent = data.agent;
  const reasons: string[] = data.reasons ?? [];

  return (
    <BlockStack gap="500">
      {/* Device + Location */}
      <InlineStack gap="600" wrap align="start">
        <BlockStack gap="150">
          <Text variant="headingSm" as="h3">Device</Text>
          {ci?.visitor_id && (
            <InfoLine label="Visitor ID" value={ci.visitor_id} />
          )}
          {ci?.browser_name && (
            <InfoLine
              label="Browser"
              value={`${ci.browser_name} ${ci.browser_full_version ?? ""}`.trim()}
            />
          )}
          {ci?.os && (
            <InfoLine
              label="OS"
              value={`${ci.os} ${ci.os_version ?? ""}`.trim()}
            />
          )}
          {ci?.incognito != null && (
            <InfoLine label="Incognito" value={ci.incognito ? "Yes" : "No"} />
          )}
          {ci?.botd?.bot?.result && (
            <InfoLine label="Bot" value={ci.botd.bot.result} />
          )}
        </BlockStack>

        <BlockStack gap="150">
          <Text variant="headingSm" as="h3">Location</Text>
          {ci?.ip_address && <InfoLine label="IP" value={ci.ip_address} />}
          {ci?.city && <InfoLine label="City" value={ci.city} />}
          {ci?.country && (
            <InfoLine
              label="Country"
              value={
                ci.country_code
                  ? `${ci.country} (${ci.country_code})`
                  : ci.country
              }
            />
          )}
          {ci?.latitude != null && (
            <InfoLine
              label="Coords"
              value={`${Number(ci.latitude).toFixed(4)}, ${Number(ci.longitude).toFixed(4)}`}
            />
          )}
        </BlockStack>
      </InlineStack>

      {/* Rules triggered */}
      {reasons.length > 0 && (
        <BlockStack gap="150">
          <Text variant="headingSm" as="h3">Rules Triggered</Text>
          <InlineStack gap="200" wrap>
            {reasons.map((r) => (
              <Badge key={r} tone="critical">
                {r}
              </Badge>
            ))}
          </InlineStack>
        </BlockStack>
      )}

      {/* Agent assessment */}
      {agent && (
        <BlockStack gap="200">
          <Text variant="headingSm" as="h3">Agent Assessment</Text>
          <InlineStack gap="200">
            <Badge tone={severityTone(agent.severity)}>{agent.severity}</Badge>
            <Badge>{agent.scenario_type?.replace(/_/g, " ")}</Badge>
          </InlineStack>
          <Text as="p">{agent.description}</Text>
          <Text as="p" fontWeight="semibold">
            Recommended: {agent.recommended_action?.replace(/_/g, " ")}
          </Text>
          {agent.analyst_questions?.length > 0 && (
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Analyst checklist:
              </Text>
              {agent.analyst_questions.map((q: string, i: number) => (
                <Text key={i} as="p" variant="bodySm">
                  • {q}
                </Text>
              ))}
            </BlockStack>
          )}
        </BlockStack>
      )}

      {/* Outcome buttons */}
      <Divider />
      <InlineStack gap="300" blockAlign="center">
        <Text variant="headingSm" as="h3">Merchant Verdict</Text>
        <OutcomeButtons fraudRequestId={fraudRequestId} />
      </InlineStack>

      {/* Chat */}
      <Divider />
      <ChatPanel fraudRequestId={fraudRequestId} />
    </BlockStack>
  );
}

// ── ChatPanel ──────────────────────────────────────────────────────────────────

type Message = { role: "user" | "assistant"; content: string };

function ChatPanel({ fraudRequestId }: { fraudRequestId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const chatFetcher = useFetcher<any>();
  const isLoading = chatFetcher.state !== "idle";

  useEffect(() => {
    if (chatFetcher.data?.reply) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: chatFetcher.data.reply },
      ]);
    }
  }, [chatFetcher.data]);

  const sendMessage = () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    const next: Message[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    chatFetcher.submit(
      { messages: next },
      {
        method: "POST",
        action: `/app/agent-chat/${fraudRequestId}`,
        encType: "application/json",
      }
    );
  };

  return (
    <BlockStack gap="300">
      <Text variant="headingSm" as="h3">Ask the Analyst Agent</Text>

      {messages.length > 0 && (
        <BlockStack gap="200">
          {messages.map((msg, i) => (
            <Box
              key={i}
              background={
                msg.role === "user" ? "bg-surface-active" : "bg-surface-secondary"
              }
              borderRadius="200"
              padding="300"
            >
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  {msg.role === "user" ? "You" : "Agent"}
                </Text>
                <Text as="p">{msg.content}</Text>
              </BlockStack>
            </Box>
          ))}
          {isLoading && (
            <Box
              background="bg-surface-secondary"
              borderRadius="200"
              padding="300"
            >
              <InlineStack gap="200" blockAlign="center">
                <Spinner size="small" />
                <Text as="p" tone="subdued">
                  Thinking…
                </Text>
              </InlineStack>
            </Box>
          )}
        </BlockStack>
      )}

      <InlineStack gap="200" blockAlign="end">
        <div style={{ flex: 1 }}>
          <TextField
            label="Message"
            labelHidden
            value={input}
            onChange={setInput}
            placeholder="Ask about this event…"
            autoComplete="off"
            disabled={isLoading}
            multiline={2}
          />
        </div>
        <Button
          variant="primary"
          onClick={sendMessage}
          loading={isLoading}
          disabled={!input.trim()}
        >
          Send
        </Button>
      </InlineStack>
    </BlockStack>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack gap="100">
      <Text as="span" variant="bodySm" tone="subdued">
        {label}:
      </Text>
      <Text as="span" variant="bodySm">
        {value}
      </Text>
    </InlineStack>
  );
}

function severityTone(
  severity: string
): "success" | "warning" | "critical" | "attention" {
  const map: Record<string, "success" | "warning" | "critical" | "attention"> =
    {
      low: "success",
      medium: "warning",
      high: "attention",
      critical: "critical",
    };
  return map[severity] ?? "attention";
}

function DecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return <Badge>Pending</Badge>;
  const tones: Record<string, "success" | "warning" | "critical" | undefined> =
    { allow: "success", review: "warning", block: "critical" };
  return <Badge tone={tones[decision]}>{decision}</Badge>;
}

function ActionBadge({ status }: { status: string | null }) {
  if (!status) return null;
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
  tone?: "success" | "caution" | "critical";
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
