/**
 * Seed script — generates 100,000+ realistic analytics events across 3 demo projects.
 *
 * Usage: pnpm seed
 *        pnpm seed --events 500000
 *        pnpm seed --project saas
 */

import { randomUUID } from "crypto";

// ─── Configuration ───────────────────────────────────────────────────────────

const TOTAL_EVENTS = parseInt(
  process.argv.find((a) => a.startsWith("--events="))?.split("=")[1] ?? "100000"
);

const TARGET_PROJECT =
  process.argv.find((a) => a.startsWith("--project="))?.split("=")[1] ?? "all";

const BATCH_SIZE = 1000;

// ─── Demo Project Definitions ────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  writeKey: string;
  users: UserProfile[];
  funnels: Funnel[];
  weight: number; // proportion of total events
}

interface UserProfile {
  userId: string;
  plan: "free" | "starter" | "pro" | "enterprise";
  country: string;
  device: "desktop" | "mobile" | "tablet";
  cohort: string; // signup week
  churned: boolean;
}

interface Funnel {
  name: string;
  steps: string[];
  conversionRate: number; // per step
}

const PROJECTS: Project[] = [
  {
    id: "proj_saas_demo",
    name: "Acme SaaS Platform",
    writeKey: "wk_demo_saas_abc123",
    weight: 0.5,
    users: generateUsers(500, {
      planWeights: { free: 0.5, starter: 0.3, pro: 0.15, enterprise: 0.05 },
    }),
    funnels: [
      {
        name: "onboarding",
        steps: [
          "signup_completed",
          "workspace_created",
          "first_project_created",
          "first_event_tracked",
          "dashboard_viewed",
        ],
        conversionRate: 0.72,
      },
      {
        name: "upgrade",
        steps: ["upgrade_modal_viewed", "plan_selected", "checkout_started", "subscription_created"],
        conversionRate: 0.4,
      },
    ],
  },
  {
    id: "proj_ecommerce_demo",
    name: "ShopFlow E-commerce",
    writeKey: "wk_demo_ecomm_def456",
    weight: 0.3,
    users: generateUsers(800, {
      planWeights: { free: 1, starter: 0, pro: 0, enterprise: 0 },
    }),
    funnels: [
      {
        name: "purchase",
        steps: [
          "product_viewed",
          "add_to_cart",
          "checkout_started",
          "payment_entered",
          "order_completed",
        ],
        conversionRate: 0.45,
      },
    ],
  },
  {
    id: "proj_mobile_demo",
    name: "Pulse Mobile App",
    writeKey: "wk_demo_mobile_ghi789",
    weight: 0.2,
    users: generateUsers(300, {
      planWeights: { free: 0.7, starter: 0, pro: 0.3, enterprise: 0 },
      deviceWeights: { desktop: 0, mobile: 0.85, tablet: 0.15 },
    }),
    funnels: [
      {
        name: "activation",
        steps: ["app_opened", "onboarding_started", "onboarding_completed", "first_action"],
        conversionRate: 0.6,
      },
    ],
  },
];

// ─── Event Templates per Project ─────────────────────────────────────────────

const SAAS_EVENTS = [
  { name: "page_viewed", weight: 0.25, props: () => ({ path: pick(["/dashboard", "/projects", "/settings", "/billing", "/team"]), title: "Page" }) },
  { name: "dashboard_viewed", weight: 0.12, props: () => ({ dashboard_id: `dash_${randomHex(6)}`, widget_count: rand(2, 12) }) },
  { name: "query_created", weight: 0.08, props: () => ({ is_ai: Math.random() > 0.4, execution_ms: rand(50, 800), row_count: rand(1, 10000) }) },
  { name: "query_saved", weight: 0.04, props: () => ({ chart_type: pick(["line", "bar", "metric", "table", "funnel"]) }) },
  { name: "ai_question_asked", weight: 0.06, props: () => ({ model: "gpt-4o", execution_ms: rand(800, 3000), confidence: (Math.random() * 0.4 + 0.6).toFixed(2) }) },
  { name: "invite_sent", weight: 0.02, props: () => ({ role: pick(["viewer", "editor", "owner"]) }) },
  { name: "upgrade_modal_viewed", weight: 0.03, props: () => ({ trigger: pick(["query_limit", "event_limit", "team_limit", "nav_click"]) }) },
  { name: "subscription_created", weight: 0.01, props: () => ({ plan: pick(["starter", "pro", "enterprise"]), revenue: pick([29, 99, 499]) }) },
  { name: "project_created", weight: 0.03, props: () => ({}) },
  { name: "api_key_created", weight: 0.02, props: () => ({ key_type: "write" }) },
  { name: "event_ingested_batch", weight: 0.15, props: () => ({ batch_size: rand(10, 500), accepted: rand(10, 500) }) },
  { name: "chart_exported", weight: 0.02, props: () => ({ format: pick(["png", "csv", "json"]) }) },
  { name: "session_started", weight: 0.07, props: () => ({ referrer: pick(["direct", "google", "twitter", "email", "github"]) }) },
  { name: "session_ended", weight: 0.07, props: () => ({ duration_seconds: rand(30, 1800), page_count: rand(1, 20) }) },
  { name: "error_encountered", weight: 0.03, props: () => ({ error_type: pick(["query_timeout", "ai_error", "ingest_rejected"]), message: "Error occurred" }) },
];

const ECOMMERCE_EVENTS = [
  { name: "page_viewed", weight: 0.2, props: () => ({ path: pick(["/", "/shop", "/product", "/cart", "/checkout", "/account"]) }) },
  { name: "product_viewed", weight: 0.18, props: () => ({ product_id: `prod_${randomHex(4)}`, category: pick(["electronics", "clothing", "home", "sports"]), price: rand(10, 500) }) },
  { name: "product_searched", weight: 0.1, props: () => ({ query: pick(["laptop", "shoes", "headphones", "jacket"]), results_count: rand(0, 50) }) },
  { name: "add_to_cart", weight: 0.1, props: () => ({ product_id: `prod_${randomHex(4)}`, quantity: rand(1, 3), price: rand(10, 500) }) },
  { name: "remove_from_cart", weight: 0.03, props: () => ({ product_id: `prod_${randomHex(4)}` }) },
  { name: "checkout_started", weight: 0.06, props: () => ({ cart_value: rand(20, 1500), item_count: rand(1, 8) }) },
  { name: "payment_entered", weight: 0.04, props: () => ({ payment_method: pick(["card", "paypal", "apple_pay", "google_pay"]) }) },
  { name: "order_completed", weight: 0.03, props: () => ({ order_id: `ord_${randomHex(8)}`, revenue: rand(20, 1500), item_count: rand(1, 8) }) },
  { name: "order_cancelled", weight: 0.01, props: () => ({ reason: pick(["changed_mind", "found_cheaper", "duplicate", "other"]) }) },
  { name: "wishlist_added", weight: 0.04, props: () => ({ product_id: `prod_${randomHex(4)}` }) },
  { name: "review_submitted", weight: 0.02, props: () => ({ rating: rand(1, 5), product_id: `prod_${randomHex(4)}` }) },
  { name: "promo_code_applied", weight: 0.02, props: () => ({ code: pick(["SAVE10", "WELCOME20", "FLASH30"]), discount: rand(5, 50) }) },
  { name: "session_started", weight: 0.09, props: () => ({ referrer: pick(["direct", "google_shopping", "instagram", "email_campaign"]) }) },
  { name: "session_ended", weight: 0.08, props: () => ({ duration_seconds: rand(30, 600), page_count: rand(1, 15) }) },
];

const MOBILE_EVENTS = [
  { name: "app_opened", weight: 0.2, props: () => ({ cold_start: Math.random() > 0.5, version: pick(["2.1.0", "2.1.1", "2.2.0"]) }) },
  { name: "screen_viewed", weight: 0.22, props: () => ({ screen: pick(["Home", "Feed", "Profile", "Settings", "Explore", "Notifications"]) }) },
  { name: "push_notification_received", weight: 0.08, props: () => ({ campaign: pick(["re-engagement", "streak", "weekly-digest"]) }) },
  { name: "push_notification_tapped", weight: 0.04, props: () => ({ campaign: pick(["re-engagement", "streak", "weekly-digest"]) }) },
  { name: "action_completed", weight: 0.1, props: () => ({ action_type: pick(["post_created", "like_sent", "comment_added", "follow_added"]) }) },
  { name: "onboarding_step_completed", weight: 0.05, props: () => ({ step: rand(1, 5), step_name: pick(["profile_setup", "notification_opt_in", "follow_suggestions", "first_post"]) }) },
  { name: "feature_used", weight: 0.1, props: () => ({ feature: pick(["search", "filters", "share", "bookmark", "dark_mode"]) }) },
  { name: "in_app_purchase", weight: 0.01, props: () => ({ product_id: pick(["pro_monthly", "pro_annual", "coins_100"]), revenue: pick([4.99, 39.99, 0.99]) }) },
  { name: "app_backgrounded", weight: 0.1, props: () => ({ session_duration_seconds: rand(30, 900) }) },
  { name: "crash_occurred", weight: 0.005, props: () => ({ screen: pick(["Feed", "Camera", "Upload"]), error_type: "NullPointerException" }) },
  { name: "permission_requested", weight: 0.02, props: () => ({ permission: pick(["camera", "notifications", "location", "contacts"]), granted: Math.random() > 0.3 }) },
  { name: "rating_prompted", weight: 0.01, props: () => ({ trigger: pick(["session_5", "action_10", "purchase"]) }) },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randomHex(len: number): string {
  return Math.random().toString(16).slice(2, 2 + len);
}

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function weightedPick<T>(items: { value: T; weight: number }[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.value;
  }
  return items[items.length - 1]!.value;
}

function generateUsers(
  count: number,
  opts: {
    planWeights?: Record<string, number>;
    deviceWeights?: Record<string, number>;
  } = {}
): UserProfile[] {
  const planW = opts.planWeights ?? { free: 0.6, starter: 0.25, pro: 0.12, enterprise: 0.03 };
  const deviceW = opts.deviceWeights ?? { desktop: 0.55, mobile: 0.38, tablet: 0.07 };
  const countries = ["US", "UK", "DE", "FR", "CA", "AU", "IN", "BR", "JP", "NL"];
  const planKeys = Object.keys(planW) as ("free" | "starter" | "pro" | "enterprise")[];
  const deviceKeys = Object.keys(deviceW) as ("desktop" | "mobile" | "tablet")[];

  return Array.from({ length: count }, (_, i) => ({
    userId: `user_${randomHex(10)}`,
    plan: weightedPick(planKeys.map((k) => ({ value: k, weight: planW[k]! }))),
    country: pick(countries),
    device: weightedPick(deviceKeys.map((k) => ({ value: k, weight: deviceW[k]! }))),
    cohort: `2024-W${String(rand(1, 52)).padStart(2, "0")}`,
    churned: Math.random() < 0.15,
  }));
}

function randomTimestamp(daysBack: number = 90): Date {
  const now = Date.now();
  const past = now - daysBack * 24 * 60 * 60 * 1000;
  return new Date(past + Math.random() * (now - past));
}

// Apply a realistic time distribution: more events on weekdays, peak hours 9–18 UTC
function biasedTimestamp(): Date {
  const base = randomTimestamp(90);
  // Weekday bias: if weekend, 40% chance to shift to weekday
  const day = base.getDay();
  if ((day === 0 || day === 6) && Math.random() > 0.4) {
    base.setDate(base.getDate() + (day === 0 ? 1 : 2));
  }
  // Hour bias: 60% chance to be in peak hours (9–18)
  if (Math.random() < 0.6) {
    base.setHours(rand(9, 18));
  }
  return base;
}

// ─── Event Generator ─────────────────────────────────────────────────────────

interface RawEvent {
  id: string;
  project_id: string;
  event_name: string;
  event_uuid: string;
  user_id: string;
  anonymous_id: string | null;
  session_id: string;
  received_at: string;
  sent_at: string;
  timestamp: string;
  country_code: string;
  device_type: string;
  app_version: string | null;
  properties: Record<string, unknown>;
  ingest_batch_id: string;
  schema_version: number;
}

function generateEvent(
  project: Project,
  user: UserProfile,
  eventTemplates: typeof SAAS_EVENTS
): RawEvent {
  const template = weightedPick(eventTemplates.map((e) => ({ value: e, weight: e.weight })));
  const ts = biasedTimestamp();
  const sentAt = new Date(ts.getTime() - rand(100, 2000)); // minor clock skew

  return {
    id: randomUUID(),
    project_id: project.id,
    event_name: template.name,
    event_uuid: randomUUID(),
    user_id: user.userId,
    anonymous_id: Math.random() > 0.8 ? `anon_${randomHex(12)}` : null,
    session_id: `sess_${randomHex(12)}`,
    received_at: new Date(ts.getTime() + rand(10, 500)).toISOString(),
    sent_at: sentAt.toISOString(),
    timestamp: ts.toISOString(),
    country_code: user.country,
    device_type: user.device,
    app_version: project.id === "proj_mobile_demo" ? pick(["2.1.0", "2.1.1", "2.2.0"]) : null,
    properties: {
      ...template.props(),
      plan: user.plan,
    },
    ingest_batch_id: `batch_${randomHex(8)}`,
    schema_version: 1,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🌱 Seeding ${TOTAL_EVENTS.toLocaleString()} events across ${PROJECTS.length} demo projects\n`);

  // In a real implementation this would connect to DuckDB directly.
  // For the seed script scaffold, we write to JSONL files that the API
  // can bulk-import via: POST /v1/admin/import?file=./data/seed/*.jsonl

  const fs = await import("fs");
  const path = await import("path");

  const outputDir = path.join(process.cwd(), "data", "seed");
  fs.mkdirSync(outputDir, { recursive: true });

  let totalGenerated = 0;

  for (const project of PROJECTS) {
    if (TARGET_PROJECT !== "all" && !project.id.includes(TARGET_PROJECT)) continue;

    const projectEvents = Math.floor(TOTAL_EVENTS * project.weight);
    const outputPath = path.join(outputDir, `${project.id}.jsonl`);
    const stream = fs.createWriteStream(outputPath);

    const templates =
      project.id === "proj_saas_demo"
        ? SAAS_EVENTS
        : project.id === "proj_ecommerce_demo"
          ? ECOMMERCE_EVENTS
          : MOBILE_EVENTS;

    console.log(`  📦 ${project.name} — ${projectEvents.toLocaleString()} events → ${outputPath}`);

    let written = 0;
    const batchStart = Date.now();

    while (written < projectEvents) {
      const batchSize = Math.min(BATCH_SIZE, projectEvents - written);
      const batch: RawEvent[] = [];

      for (let i = 0; i < batchSize; i++) {
        const user = project.users[rand(0, project.users.length - 1)]!;
        batch.push(generateEvent(project, user, templates));
      }

      for (const event of batch) {
        stream.write(JSON.stringify(event) + "\n");
      }

      written += batchSize;
      totalGenerated += batchSize;

      if (written % 10000 === 0 || written === projectEvents) {
        const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
        const rate = Math.floor(written / parseFloat(elapsed));
        process.stdout.write(`    ${written.toLocaleString()} / ${projectEvents.toLocaleString()} (${rate.toLocaleString()} events/sec)\r`);
      }
    }

    await new Promise<void>((resolve) => stream.end(resolve));
    console.log(`    ✅ ${written.toLocaleString()} events written                          `);
  }

  console.log(`\n✅ Seed complete — ${totalGenerated.toLocaleString()} total events`);
  console.log(`\nTo import into DuckDB, run:`);
  console.log(`  pnpm --filter api db:import-seed\n`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
