/**
 * Seed script — generates 100,000+ realistic product analytics events and inserts
 * them directly into DuckDB (and demo project records into PostgreSQL).
 *
 * Usage:
 *   pnpm seed                          # 120,000 events (default)
 *   pnpm seed --events=500000          # custom volume
 *   pnpm seed --project=saas           # single project
 *   pnpm seed --clear                  # drop existing seed data first
 *
 * Design principles:
 *   - Users are simulated as stateful profiles (plan, cohort, device, country)
 *   - Funnel events are generated in causal order with realistic drop-offs
 *   - Background activity fills sessions between funnel events
 *   - Timestamps follow weekday/hour patterns matching real SaaS products
 *   - All inserts go through the same bulkInsert() helper used by the production ingest path
 */

import "dotenv/config";
import { randomUUID } from "crypto";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const arg = (flag: string, fallback?: string) =>
  process.argv.find((a) => a.startsWith(`--${flag}=`))?.split("=")[1] ?? fallback;

const TOTAL_EVENTS  = parseInt(arg("events", "120000")!, 10);
const TARGET        = arg("project", "all")!;
const CLEAR_SEED    = process.argv.includes("--clear");
const BATCH_SIZE    = 2000;   // rows per DuckDB insert call

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function weightedPick<T>(items: ReadonlyArray<{ value: T; weight: number }>): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.value;
  }
  return items[items.length - 1]!.value;
}

function hex(len: number): string {
  return Math.random().toString(16).slice(2, 2 + len).padEnd(len, "0");
}

/**
 * Generate a timestamp with realistic distribution:
 * - Business hours (9–18 UTC) are ~3× more likely
 * - Weekdays are ~2.5× more likely than weekends
 * - Recency bias: more events closer to "now"
 */
function realisticTimestamp(daysBack: number, recencyBias = 0.6): Date {
  // Recency bias: exponential distribution towards present
  const rand01 = Math.random();
  const biased = recencyBias > 0 ? 1 - Math.pow(rand01, 1 / (1 - recencyBias + 0.01)) : rand01;
  const msBack = biased * daysBack * 86_400_000;
  const base = new Date(Date.now() - msBack);

  // Weekday bias
  const dow = base.getDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) {
    if (Math.random() < 0.65) {
      // Shift to a weekday
      base.setDate(base.getDate() + (dow === 0 ? 1 : 2));
    }
  }

  // Hour bias: peak 9–18, secondary 19–22, low 0–8
  const hour = base.getHours();
  if (hour < 9 && Math.random() < 0.7) {
    base.setHours(rand(9, 18));
  } else if (hour > 22 && Math.random() < 0.8) {
    base.setHours(rand(9, 18));
  }

  return base;
}

/**
 * Advance a timestamp by a realistic inter-event delay.
 * Within a session: seconds to low minutes.
 * Between funnel steps: minutes to hours (with drop-off probability).
 */
function advanceTime(base: Date, minMs: number, maxMs: number): Date {
  return new Date(base.getTime() + rand(minMs, maxMs));
}

// ─── User model ───────────────────────────────────────────────────────────────

type Plan       = "free" | "starter" | "pro" | "enterprise";
type DeviceType = "desktop" | "mobile" | "tablet";

interface User {
  userId:     string;
  plan:       Plan;
  country:    string;
  device:     DeviceType;
  os:         string;
  browser:    string;
  cohortDate: Date;   // when they signed up
  churned:    boolean;
  ltv:        number; // lifetime value in cents (0 for free)
}

const COUNTRIES  = ["US", "GB", "DE", "FR", "CA", "AU", "IN", "BR", "NL", "SE", "JP", "MX"] as const;
const OS_MAP:    Record<DeviceType, string[]> = {
  desktop: ["Windows", "macOS", "Linux"],
  mobile:  ["iOS", "Android"],
  tablet:  ["iOS", "Android", "iPadOS"],
};
const BROWSER_MAP: Record<string, string[]> = {
  Windows: ["Chrome", "Firefox", "Edge"],
  macOS:   ["Safari", "Chrome", "Firefox"],
  Linux:   ["Firefox", "Chrome"],
  iOS:     ["Safari", "Chrome"],
  Android: ["Chrome", "Samsung Internet"],
  iPadOS:  ["Safari"],
};

function makeUser(opts: { planWeights: Record<Plan, number>; deviceWeights: Record<DeviceType, number> }): User {
  const plan   = weightedPick(
    (Object.entries(opts.planWeights) as [Plan, number][]).map(([v, w]) => ({ value: v, weight: w }))
  );
  const device = weightedPick(
    (Object.entries(opts.deviceWeights) as [DeviceType, number][]).map(([v, w]) => ({ value: v, weight: w }))
  );
  const os      = pick(OS_MAP[device]);
  const browser = pick(BROWSER_MAP[os] ?? ["Chrome"]);
  const country = weightedPick([
    { value: "US", weight: 0.35 }, { value: "GB", weight: 0.10 }, { value: "DE", weight: 0.08 },
    { value: "FR", weight: 0.06 }, { value: "CA", weight: 0.07 }, { value: "AU", weight: 0.06 },
    { value: "IN", weight: 0.08 }, { value: "BR", weight: 0.05 }, { value: "NL", weight: 0.04 },
    { value: "SE", weight: 0.03 }, { value: "JP", weight: 0.04 }, { value: "MX", weight: 0.04 },
  ]);
  const cohortDaysBack = rand(1, 365);
  const ltv =
    plan === "free" ? 0 :
    plan === "starter" ? rand(29, 300) * 100 :
    plan === "pro"     ? rand(99, 1200) * 100 :
                          rand(499, 6000) * 100;

  return {
    userId:     `user_${hex(12)}`,
    plan,
    country,
    device,
    os,
    browser,
    cohortDate: new Date(Date.now() - cohortDaysBack * 86_400_000),
    churned:    Math.random() < 0.12,
    ltv,
  };
}

// ─── Raw event row builder ────────────────────────────────────────────────────

interface RawRow {
  id:              string;
  project_id:      string;
  event_name:      string;
  event_uuid:      string;
  user_id:         string;
  anonymous_id:    string | null;
  session_id:      string;
  received_at:     string;
  sent_at:         string;
  timestamp:       string;
  ip_address:      string | null;
  country_code:    string;
  city:            string | null;
  device_type:     string;
  os_name:         string;
  browser_name:    string;
  app_version:     string | null;
  properties:      string;
  ingest_batch_id: string;
  schema_version:  number;
}

function makeRow(
  projectId: string,
  user: User,
  eventName: string,
  ts: Date,
  sessionId: string,
  batchId: string,
  props: Record<string, unknown> = {},
  appVersion?: string
): RawRow {
  const allProps = { ...props, plan: user.plan };
  const receivedAt = new Date(ts.getTime() + rand(20, 600));
  const sentAt     = new Date(ts.getTime() - rand(0, 200));

  return {
    id:              randomUUID(),
    project_id:      projectId,
    event_name:      eventName,
    event_uuid:      randomUUID(),
    user_id:         user.userId,
    anonymous_id:    null,
    session_id:      sessionId,
    received_at:     receivedAt.toISOString(),
    sent_at:         sentAt.toISOString(),
    timestamp:       ts.toISOString(),
    ip_address:      null,
    country_code:    user.country,
    city:            null,
    device_type:     user.device,
    os_name:         user.os,
    browser_name:    user.browser,
    app_version:     appVersion ?? null,
    properties:      JSON.stringify(allProps),
    ingest_batch_id: batchId,
    schema_version:  1,
  };
}

// ─── Project definitions ──────────────────────────────────────────────────────

interface ProjectDef {
  id:           string;
  workspaceId:  string;
  name:         string;
  writeKey:     string;
  weight:       number;
  userCount:    number;
  planWeights:  Record<Plan, number>;
  deviceWeights: Record<DeviceType, number>;
}

const WORKSPACE_ID = "ws_seed_demo_0001";

const PROJECTS: ProjectDef[] = [
  {
    id:          "proj_saas_demo_0001",
    workspaceId: WORKSPACE_ID,
    name:        "Acme SaaS Platform",
    writeKey:    "wk_demo_saas_abc1234567",
    weight:      0.50,
    userCount:   600,
    planWeights:  { free: 0.50, starter: 0.28, pro: 0.17, enterprise: 0.05 },
    deviceWeights: { desktop: 0.62, mobile: 0.30, tablet: 0.08 },
  },
  {
    id:          "proj_ecomm_demo_0001",
    workspaceId: WORKSPACE_ID,
    name:        "ShopFlow E-commerce",
    writeKey:    "wk_demo_ecomm_def7654321",
    weight:      0.30,
    userCount:   900,
    planWeights:  { free: 1.00, starter: 0.00, pro: 0.00, enterprise: 0.00 },
    deviceWeights: { desktop: 0.45, mobile: 0.48, tablet: 0.07 },
  },
  {
    id:          "proj_mobile_demo_0001",
    workspaceId: WORKSPACE_ID,
    name:        "Pulse Mobile App",
    writeKey:    "wk_demo_mobile_ghi9876543",
    weight:      0.20,
    userCount:   400,
    planWeights:  { free: 0.65, starter: 0.00, pro: 0.35, enterprise: 0.00 },
    deviceWeights: { desktop: 0.00, mobile: 0.82, tablet: 0.18 },
  },
];

// ─── Per-project event generators ────────────────────────────────────────────

/**
 * Simulate a SaaS user's full journey over their account lifetime.
 * Events are generated in causal order; funnel drop-offs are modelled explicitly.
 */
function* generateSaaSJourney(
  project: ProjectDef,
  user: User,
  batchId: string
): Generator<RawRow> {
  const pid = project.id;
  let ts = realisticTimestamp(
    Math.floor((Date.now() - user.cohortDate.getTime()) / 86_400_000),
    0.4
  );
  const sessionId = () => `sess_${hex(14)}`;

  // ── Signup funnel ──────────────────────────────────────────────────────────
  let sid = sessionId();
  yield makeRow(pid, user, "page_viewed", ts, sid, batchId, { path: "/", referrer: pick(["google", "direct", "twitter", "hacker_news"]) });
  ts = advanceTime(ts, 5_000, 60_000);
  yield makeRow(pid, user, "signup_started", ts, sid, batchId, { source: pick(["cta_hero", "cta_nav", "pricing_page"]) });
  ts = advanceTime(ts, 20_000, 120_000);

  // 88% complete signup
  if (Math.random() > 0.12) {
    yield makeRow(pid, user, "signup_completed", ts, sid, batchId, { method: pick(["email", "google", "github"]) });
    ts = advanceTime(ts, 2_000, 10_000);
    yield makeRow(pid, user, "workspace_created", ts, sid, batchId, { plan: user.plan });
    ts = advanceTime(ts, 5_000, 30_000);

    // 79% create first project
    if (Math.random() > 0.21) {
      yield makeRow(pid, user, "first_project_created", ts, sid, batchId, {});
      ts = advanceTime(ts, 10_000, 120_000);

      // 68% track first event
      if (Math.random() > 0.32) {
        yield makeRow(pid, user, "first_event_tracked", ts, sid, batchId, { sdk: pick(["js", "python", "node", "ruby"]) });
        ts = advanceTime(ts, 30_000, 300_000);

        // 55% view dashboard
        if (Math.random() > 0.45) {
          yield makeRow(pid, user, "dashboard_viewed", ts, sid, batchId, {
            dashboard_id: `dash_${hex(6)}`,
            widget_count:  rand(2, 8),
          });
        }
      }
    }
  } else {
    return; // dropped off at signup
  }

  if (user.churned) return;

  // ── Recurring usage sessions (1–30 sessions over their account lifetime) ──
  const sessionCount = weightedPick([
    { value: rand(1, 3),   weight: 0.30 },
    { value: rand(4, 10),  weight: 0.40 },
    { value: rand(11, 30), weight: 0.30 },
  ]);

  for (let s = 0; s < sessionCount; s++) {
    ts = advanceTime(ts, 3_600_000, 7 * 86_400_000); // 1hr–7d between sessions
    sid = sessionId();

    const eventsInSession = rand(3, 20);
    for (let e = 0; e < eventsInSession; e++) {
      const eventName = weightedPick([
        { value: "page_viewed",          weight: 0.22 },
        { value: "dashboard_viewed",     weight: 0.14 },
        { value: "query_created",        weight: 0.10 },
        { value: "ai_question_asked",    weight: 0.08 },
        { value: "query_saved",          weight: 0.05 },
        { value: "chart_exported",       weight: 0.03 },
        { value: "invite_sent",          weight: 0.02 },
        { value: "feature_used",         weight: 0.10 },
        { value: "event_ingested_batch", weight: 0.14 },
        { value: "settings_updated",     weight: 0.03 },
        { value: "api_key_created",      weight: 0.02 },
        { value: "error_encountered",    weight: 0.02 },
        { value: "session_started",      weight: 0.05 },
      ]);

      const props: Record<string, unknown> = {};
      if (eventName === "page_viewed")
        props["path"] = pick(["/dashboard", "/projects", "/settings", "/billing", "/team", "/queries"]);
      if (eventName === "dashboard_viewed")
        props["dashboard_id"] = `dash_${hex(6)}`;
      if (eventName === "query_created") {
        props["is_ai"]       = Math.random() > 0.45;
        props["execution_ms"] = rand(40, 900);
        props["row_count"]    = rand(1, 50000);
      }
      if (eventName === "ai_question_asked") {
        props["model"]        = "gpt-4o";
        props["execution_ms"] = rand(800, 3500);
        props["confidence"]   = parseFloat(randFloat(0.55, 0.99).toFixed(2));
      }
      if (eventName === "feature_used")
        props["feature"] = pick(["saved_queries", "ai_copilot", "csv_export", "api_access", "team_sharing"]);
      if (eventName === "event_ingested_batch") {
        props["batch_size"] = rand(10, 500);
        props["accepted"]   = rand(10, 500);
      }

      yield makeRow(pid, user, eventName, ts, sid, batchId, props);
      ts = advanceTime(ts, 5_000, 180_000);
    }
  }

  // ── Upgrade funnel (non-free users) ───────────────────────────────────────
  if (user.plan !== "free" && Math.random() > 0.3) {
    ts = advanceTime(ts, 86_400_000, 30 * 86_400_000);
    sid = sessionId();

    yield makeRow(pid, user, "upgrade_modal_viewed", ts, sid, batchId, {
      trigger: pick(["query_limit", "event_limit", "team_limit", "nav_click"]),
    });
    ts = advanceTime(ts, 10_000, 300_000);

    if (Math.random() > 0.45) {
      yield makeRow(pid, user, "plan_selected", ts, sid, batchId, { plan: user.plan });
      ts = advanceTime(ts, 5_000, 60_000);

      if (Math.random() > 0.30) {
        yield makeRow(pid, user, "checkout_started", ts, sid, batchId, { plan: user.plan });
        ts = advanceTime(ts, 30_000, 300_000);

        if (Math.random() > 0.20) {
          yield makeRow(pid, user, "subscription_upgraded", ts, sid, batchId, {
            plan:    user.plan,
            revenue: user.plan === "starter" ? 29 : user.plan === "pro" ? 99 : 499,
          });
        }
      }
    }
  }
}

function* generateEcommerceJourney(
  project: ProjectDef,
  user: User,
  batchId: string
): Generator<RawRow> {
  const pid = project.id;
  const sessionId = () => `sess_${hex(14)}`;

  // Simulate 1–8 shopping sessions
  const sessionCount = rand(1, 8);
  let ts = realisticTimestamp(180, 0.5);

  for (let s = 0; s < sessionCount; s++) {
    if (s > 0) ts = advanceTime(ts, 2 * 86_400_000, 30 * 86_400_000);
    const sid = sessionId();

    // Session start
    yield makeRow(pid, user, "session_started", ts, sid, batchId, {
      referrer: pick(["direct", "google_shopping", "instagram_ad", "email_campaign", "affiliate"]),
    });
    ts = advanceTime(ts, 3_000, 30_000);

    // Browse 2–8 products
    const browseCount = rand(2, 8);
    const viewedProducts: string[] = [];
    for (let p = 0; p < browseCount; p++) {
      const productId = `prod_${hex(6)}`;
      viewedProducts.push(productId);
      yield makeRow(pid, user, "product_viewed", ts, sid, batchId, {
        product_id: productId,
        category:   pick(["electronics", "clothing", "home", "sports", "books", "beauty"]),
        price:      rand(5, 800),
        in_stock:   Math.random() > 0.05,
      });
      ts = advanceTime(ts, 15_000, 180_000);

      // 15% chance of searching
      if (Math.random() < 0.15) {
        yield makeRow(pid, user, "product_searched", ts, sid, batchId, {
          query:         pick(["laptop", "running shoes", "headphones", "winter jacket", "coffee maker"]),
          results_count: rand(3, 80),
        });
        ts = advanceTime(ts, 5_000, 30_000);
      }
    }

    // 38% add to cart
    if (Math.random() < 0.38 && viewedProducts.length > 0) {
      const cartItem = pick(viewedProducts);
      yield makeRow(pid, user, "add_to_cart", ts, sid, batchId, {
        product_id: cartItem,
        quantity:   rand(1, 3),
        price:      rand(5, 800),
      });
      ts = advanceTime(ts, 10_000, 120_000);

      // 10% add promo code
      if (Math.random() < 0.10) {
        yield makeRow(pid, user, "promo_code_applied", ts, sid, batchId, {
          code:     pick(["SAVE10", "WELCOME20", "FLASH30", "VIP50"]),
          discount: rand(5, 50),
        });
        ts = advanceTime(ts, 3_000, 20_000);
      }

      // 55% start checkout
      if (Math.random() < 0.55) {
        const cartValue = rand(20, 1500);
        yield makeRow(pid, user, "checkout_started", ts, sid, batchId, {
          cart_value: cartValue,
          item_count: rand(1, 5),
        });
        ts = advanceTime(ts, 30_000, 600_000);

        // 72% enter payment
        if (Math.random() < 0.72) {
          yield makeRow(pid, user, "payment_entered", ts, sid, batchId, {
            payment_method: pick(["card", "paypal", "apple_pay", "google_pay", "klarna"]),
          });
          ts = advanceTime(ts, 10_000, 120_000);

          // 85% complete order
          if (Math.random() < 0.85) {
            yield makeRow(pid, user, "order_completed", ts, sid, batchId, {
              order_id:   `ord_${hex(10)}`,
              revenue:    cartValue,
              item_count: rand(1, 5),
            });
          } else {
            yield makeRow(pid, user, "checkout_abandoned", ts, sid, batchId, {
              step:   "payment",
              reason: pick(["payment_failed", "changed_mind", "address_issue"]),
            });
          }
        } else {
          yield makeRow(pid, user, "checkout_abandoned", ts, sid, batchId, {
            step:   "address",
            reason: pick(["no_delivery", "too_expensive", "distracted"]),
          });
        }
      }
    }

    // Session end
    yield makeRow(pid, user, "session_ended", ts, sid, batchId, {
      duration_seconds: rand(60, 1800),
      page_count:       rand(2, 20),
    });
    ts = advanceTime(ts, 5_000, 30_000);
  }

  // Post-purchase events
  if (Math.random() < 0.25) {
    ts = advanceTime(ts, 2 * 86_400_000, 14 * 86_400_000);
    yield makeRow(pid, user, "review_submitted", ts, sessionId(), batchId, {
      rating:     rand(3, 5),
      product_id: `prod_${hex(6)}`,
    });
  }
}

function* generateMobileJourney(
  project: ProjectDef,
  user: User,
  batchId: string
): Generator<RawRow> {
  const pid = project.id;
  const APP_VERSIONS = ["2.0.0", "2.1.0", "2.1.1", "2.2.0"] as const;
  const appVersion   = pick(APP_VERSIONS);
  const sessionId    = () => `sess_${hex(14)}`;

  let ts = realisticTimestamp(180, 0.5);

  // ── First launch / onboarding ─────────────────────────────────────────────
  let sid = sessionId();
  yield makeRow(pid, user, "app_installed", ts, sid, batchId, { source: pick(["app_store", "play_store", "referral"]) }, appVersion);
  ts = advanceTime(ts, 2_000, 10_000);
  yield makeRow(pid, user, "app_opened", ts, sid, batchId, { cold_start: true, version: appVersion }, appVersion);
  ts = advanceTime(ts, 1_000, 5_000);
  yield makeRow(pid, user, "onboarding_started", ts, sid, batchId, {}, appVersion);

  // Onboarding steps — each has ~78% conversion to next
  const onboardingSteps = [
    { step: 1, name: "profile_setup" },
    { step: 2, name: "notification_opt_in" },
    { step: 3, name: "follow_suggestions" },
    { step: 4, name: "first_post_prompt" },
  ];

  let completedOnboarding = true;
  for (const step of onboardingSteps) {
    if (Math.random() > 0.78) { completedOnboarding = false; break; }
    ts = advanceTime(ts, 10_000, 90_000);
    yield makeRow(pid, user, "onboarding_step_completed", ts, sid, batchId, {
      step:      step.step,
      step_name: step.name,
    }, appVersion);
  }

  if (completedOnboarding) {
    ts = advanceTime(ts, 5_000, 20_000);
    yield makeRow(pid, user, "onboarding_completed", ts, sid, batchId, {}, appVersion);
    ts = advanceTime(ts, 3_000, 10_000);
    yield makeRow(pid, user, "first_action", ts, sid, batchId, {
      action: pick(["post_created", "follow_added", "like_sent"]),
    }, appVersion);
  } else {
    return;
  }

  if (user.churned) return;

  // ── Recurring sessions ────────────────────────────────────────────────────
  const totalSessions = weightedPick([
    { value: rand(2, 5),   weight: 0.25 },
    { value: rand(6, 15),  weight: 0.40 },
    { value: rand(16, 50), weight: 0.35 },
  ]);

  for (let s = 0; s < totalSessions; s++) {
    ts = advanceTime(ts, 3_600_000, 3 * 86_400_000); // 1hr–3d between sessions
    sid = sessionId();

    yield makeRow(pid, user, "app_opened", ts, sid, batchId, {
      cold_start: Math.random() > 0.6,
      version:    appVersion,
    }, appVersion);
    ts = advanceTime(ts, 500, 3_000);

    const screens = rand(2, 12);
    for (let sc = 0; sc < screens; sc++) {
      const screen = pick(["Home", "Feed", "Profile", "Explore", "Notifications", "Settings", "Search"]);
      yield makeRow(pid, user, "screen_viewed", ts, sid, batchId, { screen }, appVersion);
      ts = advanceTime(ts, 5_000, 60_000);

      // Actions per screen
      if (screen === "Feed" && Math.random() < 0.60) {
        yield makeRow(pid, user, "action_completed", ts, sid, batchId, {
          action_type: pick(["like_sent", "comment_added", "share_tapped", "bookmark_added"]),
        }, appVersion);
        ts = advanceTime(ts, 2_000, 15_000);
      }

      if (screen === "Explore" && Math.random() < 0.35) {
        yield makeRow(pid, user, "feature_used", ts, sid, batchId, {
          feature: pick(["search", "trending_topics", "recommended_users", "hashtag_browse"]),
        }, appVersion);
        ts = advanceTime(ts, 5_000, 30_000);
      }
    }

    // Push notification interaction
    if (Math.random() < 0.18) {
      const campaign = pick(["re-engagement", "streak_reminder", "weekly_digest", "new_follower"]);
      yield makeRow(pid, user, "push_notification_received", ts, sid, batchId, { campaign }, appVersion);
      if (Math.random() < 0.30) {
        ts = advanceTime(ts, 1_000, 30_000);
        yield makeRow(pid, user, "push_notification_tapped", ts, sid, batchId, { campaign }, appVersion);
      }
    }

    // In-app purchase (pro users more likely)
    const purchaseChance = user.plan === "pro" ? 0.08 : 0.02;
    if (Math.random() < purchaseChance) {
      yield makeRow(pid, user, "in_app_purchase", ts, sid, batchId, {
        product_id: pick(["pro_monthly", "pro_annual", "coins_100", "coins_500"]),
        revenue:    pick([0.99, 4.99, 9.99, 39.99]),
      }, appVersion);
    }

    // Rare crash
    if (Math.random() < 0.008) {
      yield makeRow(pid, user, "crash_occurred", ts, sid, batchId, {
        screen:     pick(["Feed", "Camera", "Upload", "Profile"]),
        error_type: pick(["NullPointerException", "OutOfMemoryError", "NetworkException"]),
        app_version: appVersion,
      }, appVersion);
    }

    // App backgrounded
    yield makeRow(pid, user, "app_backgrounded", ts, sid, batchId, {
      session_duration_seconds: rand(30, 1200),
    }, appVersion);
    ts = advanceTime(ts, 1_000, 5_000);
  }
}

// ─── Batch accumulator ────────────────────────────────────────────────────────

const COLUMNS = [
  "id", "project_id", "event_name", "event_uuid",
  "user_id", "anonymous_id", "session_id",
  "received_at", "sent_at", "timestamp",
  "ip_address", "country_code", "city",
  "device_type", "os_name", "browser_name", "app_version",
  "properties", "ingest_batch_id", "schema_version",
] as const;

function rowToArray(r: RawRow): unknown[] {
  return [
    r.id, r.project_id, r.event_name, r.event_uuid,
    r.user_id, r.anonymous_id, r.session_id,
    r.received_at, r.sent_at, r.timestamp,
    r.ip_address, r.country_code, r.city,
    r.device_type, r.os_name, r.browser_name, r.app_version,
    r.properties, r.ingest_batch_id, r.schema_version,
  ];
}

// ─── PostgreSQL seed (demo workspace + projects) ──────────────────────────────

async function seedPostgres(): Promise<void> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });

  try {
    // Seed workspace
    await pool.query(`
      INSERT INTO workspaces (id, name, slug, plan)
      VALUES ($1, 'Demo Workspace', 'demo-workspace', 'pro')
      ON CONFLICT (id) DO NOTHING
    `, [WORKSPACE_ID]);

    // Seed demo user
    const demoUserId = "user_demo_admin_0001";
    await pool.query(`
      INSERT INTO users (id, email, name, password_hash)
      VALUES ($1, 'demo@example.com', 'Demo Admin', $2)
      ON CONFLICT (id) DO NOTHING
    `, [demoUserId, "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918"]);
    // ^ sha256("admin") — demo only, never use in production

    await pool.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role, accepted_at)
      VALUES ($1, $2, 'owner', now())
      ON CONFLICT (workspace_id, user_id) DO NOTHING
    `, [WORKSPACE_ID, demoUserId]);

    for (const p of PROJECTS) {
      await pool.query(`
        INSERT INTO projects (id, workspace_id, name, write_key, duckdb_table_suffix)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO NOTHING
      `, [p.id, p.workspaceId, p.name, p.writeKey, `proj_${p.id.replace(/[^a-z0-9]/g, "_")}`]);
    }

    console.log("  ✓ PostgreSQL: demo workspace, user, and projects seeded");
  } finally {
    await pool.end();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🌱  Seed — ${TOTAL_EVENTS.toLocaleString()} events across ${PROJECTS.length} projects\n`);

  // Lazy-import so this script can be run standalone with tsx
  const { initDuckDB, bulkInsert, getDuckDB } = await import(
    "../packages/api/src/db/duckdb.js"
  );

  const db = await initDuckDB();

  // Seed PostgreSQL (idempotent)
  try {
    await seedPostgres();
  } catch (err) {
    console.warn("  ⚠️  PostgreSQL seed skipped (is DATABASE_URL set?):", (err as Error).message);
  }

  // Clear existing seed data if requested
  if (CLEAR_SEED) {
    console.log("\n  🗑  Clearing existing seed events…");
    for (const p of PROJECTS) {
      await db.run(`DELETE FROM events WHERE project_id = ?`, p.id);
    }
    console.log("  ✓  Cleared.\n");
  }

  let grandTotal = 0;
  const startTime = Date.now();

  for (const project of PROJECTS) {
    if (TARGET !== "all" && !project.id.includes(TARGET)) continue;

    const projectTarget = Math.floor(TOTAL_EVENTS * project.weight);
    console.log(`\n  📦  ${project.name}`);
    console.log(`       Target: ${projectTarget.toLocaleString()} events`);
    console.log(`       Users:  ${project.userCount}`);

    // Pre-generate users
    const users: User[] = Array.from({ length: project.userCount }, () =>
      makeUser({ planWeights: project.planWeights, deviceWeights: project.deviceWeights })
    );

    const generator =
      project.id.startsWith("proj_saas")    ? generateSaaSJourney :
      project.id.startsWith("proj_ecomm")   ? generateEcommerceJourney :
                                               generateMobileJourney;

    let batch: unknown[][] = [];
    let projectTotal = 0;
    let userIdx = 0;
    const batchId = `seed_${hex(12)}`;

    const flushBatch = async () => {
      if (batch.length === 0) return;
      await bulkInsert("events", [...COLUMNS], batch);
      projectTotal += batch.length;
      grandTotal   += batch.length;
      batch = [];

      const elapsed = (Date.now() - startTime) / 1000;
      const rate    = Math.round(grandTotal / elapsed);
      process.stdout.write(
        `       ${projectTotal.toLocaleString()} / ${projectTarget.toLocaleString()} events  (${rate.toLocaleString()} evt/s)\r`
      );
    };

    // Round-robin through users, generating journeys until we hit the target
    while (projectTotal + batch.length < projectTarget) {
      const user = users[userIdx % users.length]!;
      userIdx++;

      for (const row of generator(project, user, batchId)) {
        batch.push(rowToArray(row));
        if (batch.length >= BATCH_SIZE) {
          await flushBatch();
          if (projectTotal >= projectTarget) break;
        }
      }
    }

    await flushBatch();

    // Final count from DuckDB (authoritative)
    const countResult = await db.all(
      `SELECT count(*) AS n FROM events WHERE project_id = ?`,
      project.id
    );
    const dbCount = Number((countResult[0] ?? {})["n"] ?? 0);
    console.log(`\n       ✅  ${projectTotal.toLocaleString()} events inserted (${dbCount.toLocaleString()} total in DB)`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rate    = Math.round(grandTotal / parseFloat(elapsed));

  console.log(`\n✅  Seed complete`);
  console.log(`    Events generated : ${grandTotal.toLocaleString()}`);
  console.log(`    Elapsed          : ${elapsed}s`);
  console.log(`    Throughput       : ${rate.toLocaleString()} events/sec`);
  console.log(`\n    Login with: demo@example.com / admin`);
  console.log(`    Projects available:\n`);
  for (const p of PROJECTS) {
    console.log(`      ${p.name}`);
    console.log(`        Write key : ${p.writeKey}`);
    console.log(`        Project ID: ${p.id}\n`);
  }
}

main().catch((err: unknown) => {
  console.error("\n❌  Seed failed:", err);
  process.exit(1);
});
