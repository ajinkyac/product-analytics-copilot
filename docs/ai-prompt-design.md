# AI Prompt Design

## Overview

The AI layer performs two distinct tasks:

1. **NL → SQL** — Convert a natural language question into valid DuckDB SQL, scoped to a specific project's event schema.
2. **Result Narration** — Summarize a query result set into a concise, insight-focused plain English sentence or paragraph.

This document covers the prompt engineering strategy for both tasks, including system prompt templates, few-shot examples, guardrails, and evaluation criteria.

---

## 1. NL → SQL Generation

### 1.1 Model Choice

**Primary:** `gpt-4o` with `response_format: { type: "json_schema" }` (structured output).
**Fallback:** `gpt-4o-mini` for simple queries (single aggregation, no subqueries) — detected by question complexity heuristic.

Structured output is mandatory for SQL extraction. Free-form text responses require fragile regex parsing and are a source of hallucination leakage.

### 1.2 System Prompt Template

```
You are an expert DuckDB SQL analyst embedded in a product analytics platform.

Your job is to convert a natural language question about user behavior into a valid DuckDB SQL query.

## Database Schema

Table: events
Columns:
{{#each columns}}
  - {{name}} ({{type}}): {{description}}
{{/each}}

Known event names for this project:
{{#each eventNames}}
  - "{{this}}"
{{/each}}

Frequently used property keys (from `properties` JSON column):
{{#each propertyKeys}}
  - "{{key}}" ({{type}}): seen in {{percentage}}% of events
{{/each}}

## Rules

1. ALWAYS include `WHERE project_id = '{{projectId}}'` in every query.
2. NEVER generate INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, or any DDL/DML statement.
3. NEVER use subqueries that reference tables other than `events` or the allowed materialized views: [mv_daily_active_users, mv_event_volume].
4. Use `timestamp` column for all time-based filtering, not `received_at` or `sent_at`.
5. When a time range is implied ("last week", "past 30 days"), convert it using DuckDB interval syntax: `timestamp >= now() - INTERVAL '7 days'`.
6. For "active users", use `count(distinct user_id)`.
7. For funnel analysis, use a self-join or window function pattern — do NOT use a pivot.
8. If the question is ambiguous, make the most common reasonable interpretation and note the assumption in `explanation`.
9. Return only valid DuckDB SQL syntax. Do NOT use PostgreSQL-specific functions.
10. If the question CANNOT be answered with the available schema, set `answerable` to false and explain why.

## Output Format

Respond with a JSON object matching this schema:
{
  "answerable": boolean,
  "sql": string | null,
  "explanation": string,       // plain English explanation of what the SQL does
  "assumptions": string[],     // list of any interpretation decisions made
  "confidence": number,        // 0.0 to 1.0
  "suggestedChartType": "line" | "bar" | "area" | "pie" | "metric" | "funnel" | "table" | "heatmap"
}
```

### 1.3 User Message Template

```
Project context: {{projectName}}
Time range requested: {{timeRange}} (from {{startDate}} to {{endDate}})

Question: {{userQuestion}}
```

### 1.4 Schema Injection Strategy

The schema is injected dynamically per-request. To stay within token budgets:

- **Column definitions:** Always include all 12 core columns (truncated descriptions).
- **Event names:** Include all known event names (usually < 50; DuckDB-queried from `mv_event_volume`).
- **Property keys:** Include top-50 by frequency, with type and percentage. This prevents hallucinated property names.
- **Total schema tokens:** Target < 800 tokens. If property keys exceed this, include top-30 by frequency.

Token budget calculation:
```
System prompt base  ~400 tokens
Schema injection    ~600 tokens
Few-shot examples   ~800 tokens
User question       ~50 tokens
─────────────────────────────
Total (input)       ~1,850 tokens (well within gpt-4o 128k context)
```

---

## 2. Few-Shot Examples

Few-shot examples are injected into the system prompt after the rules section. They are curated manually and cover the most common query patterns.

### Example 1: Simple Count with Time Filter

```
User: How many sign-up events happened this week?

Response:
{
  "answerable": true,
  "sql": "SELECT count(*) AS signups FROM events WHERE project_id = '{{projectId}}' AND event_name = 'user_signed_up' AND timestamp >= date_trunc('week', now())",
  "explanation": "Counts all sign-up events since the start of the current calendar week.",
  "assumptions": ["'This week' is interpreted as the current calendar week, starting Monday."],
  "confidence": 0.97,
  "suggestedChartType": "metric"
}
```

### Example 2: Daily Active Users Trend

```
User: Show me DAU for the past 30 days

Response:
{
  "answerable": true,
  "sql": "SELECT date_trunc('day', timestamp) AS date, count(distinct user_id) AS dau FROM events WHERE project_id = '{{projectId}}' AND timestamp >= now() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1",
  "explanation": "Returns the count of unique users per day for the last 30 days, ordered chronologically.",
  "assumptions": [],
  "confidence": 0.99,
  "suggestedChartType": "line"
}
```

### Example 3: Event Funnel

```
User: What's the conversion rate from trial_started to subscription_created?

Response:
{
  "answerable": true,
  "sql": "WITH step1 AS (SELECT distinct user_id FROM events WHERE project_id = '{{projectId}}' AND event_name = 'trial_started' AND timestamp >= now() - INTERVAL '30 days'), step2 AS (SELECT distinct e.user_id FROM events e JOIN step1 s ON e.user_id = s.user_id WHERE e.project_id = '{{projectId}}' AND e.event_name = 'subscription_created' AND e.timestamp >= now() - INTERVAL '30 days') SELECT count(*) AS trial_started, (SELECT count(*) FROM step2) AS subscription_created, round(100.0 * (SELECT count(*) FROM step2) / nullif(count(*), 0), 2) AS conversion_pct FROM step1",
  "explanation": "Calculates the funnel conversion from trial_started to subscription_created over the last 30 days. Users who completed both steps are counted in the conversion.",
  "assumptions": ["A user can only complete each step once (using DISTINCT user_id).", "The 30-day window applies to both steps."],
  "confidence": 0.88,
  "suggestedChartType": "funnel"
}
```

### Example 4: Property-Based Segmentation

```
User: Break down signups by plan type last month

Response:
{
  "answerable": true,
  "sql": "SELECT json_extract_string(properties, '$.plan') AS plan, count(*) AS signups FROM events WHERE project_id = '{{projectId}}' AND event_name = 'user_signed_up' AND timestamp >= date_trunc('month', now()) - INTERVAL '1 month' AND timestamp < date_trunc('month', now()) GROUP BY 1 ORDER BY 2 DESC",
  "explanation": "Groups sign-up events by the 'plan' property and counts them for the previous calendar month.",
  "assumptions": ["'Plan type' is extracted from the 'plan' key in the properties JSON."],
  "confidence": 0.91,
  "suggestedChartType": "bar"
}
```

### Example 5: Unanswerable Question

```
User: What's the revenue per user by country?

Response:
{
  "answerable": false,
  "sql": null,
  "explanation": "This question requires a 'revenue' property in events. The current project schema does not include a 'revenue' property key in tracked events. If you track revenue in your event properties, please confirm the exact property name.",
  "assumptions": [],
  "confidence": 0.0,
  "suggestedChartType": "table"
}
```

---

## 3. Guardrails

### 3.1 Input Guardrails (before sending to LLM)

| Check | Mechanism | Action on Failure |
|---|---|---|
| Question length | Reject if > 500 chars | Return 400 with "Question too long" |
| Prompt injection patterns | Regex: `ignore previous instructions`, `you are now`, `disregard` | Sanitize or reject |
| PII in question | spaCy NER on question text (optional, v2) | Flag for review |
| Project ID injection | Never trust projectId from user message; always from JWT | — |

### 3.2 Output Guardrails (before executing LLM-generated SQL)

All generated SQL passes through a validation pipeline before DuckDB execution:

```typescript
async function validateGeneratedSQL(sql: string, projectId: string): Promise<ValidationResult> {
  // 1. AST parse — reject if parse fails
  const ast = parseSQLToAST(sql); // node-sql-parser
  if (!ast) return { valid: false, reason: "SQL parse error" };

  // 2. Statement type check — only SELECT allowed
  if (ast.type !== "select") {
    return { valid: false, reason: `Disallowed statement type: ${ast.type}` };
  }

  // 3. Table whitelist — only 'events' and allowed materialized views
  const tables = extractTableNames(ast);
  const allowed = new Set(["events", "mv_daily_active_users", "mv_event_volume"]);
  const disallowed = tables.filter(t => !allowed.has(t));
  if (disallowed.length > 0) {
    return { valid: false, reason: `Disallowed table reference: ${disallowed.join(", ")}` };
  }

  // 4. project_id binding check — must be present
  if (!sqlContainsProjectIdFilter(ast, projectId)) {
    // Auto-inject if missing (belt and suspenders)
    sql = injectProjectIdFilter(sql, projectId);
  }

  // 5. Complexity limits
  const complexity = estimateSQLComplexity(ast);
  if (complexity.estimatedCost > MAX_QUERY_COST) {
    return { valid: false, reason: "Query too complex; try a narrower time range" };
  }

  return { valid: true, sql };
}
```

### 3.3 Runtime Guardrails

- **Row limit:** All queries are wrapped with `LIMIT 10000` unless the user explicitly requests more.
- **Timeout:** DuckDB query timeout set to 30s; returns a partial result with a warning if exceeded.
- **Result size:** Results > 50MB are truncated and the user is warned to add a `LIMIT` clause.

---

## 4. Result Narration (Summarization)

### 4.1 System Prompt

```
You are a data analyst summarizing query results for a product team.

Given a SQL query, its results (as a sample), and the original question, write a single concise sentence or short paragraph (max 3 sentences) that:
1. Directly answers the question with the key number(s).
2. Highlights the most interesting trend, comparison, or anomaly in the data.
3. Uses plain language — no SQL jargon.

Do NOT:
- Say "the data shows" or "according to the results".
- Repeat the question verbatim.
- Mention the SQL or technical implementation.
- Add caveats not supported by the data.

Respond with plain text only (no JSON, no markdown).
```

### 4.2 User Message Template

```
Question: {{question}}

SQL: {{sql}}

Result sample (first 5 rows):
{{resultSample}}

Total row count: {{rowCount}}
```

### 4.3 Narration Examples

**Input:** "How many users signed up last week?"
**Result:** `[{ signups: 1247 }]`
**Narration:** `1,247 users signed up last week — a 12% increase compared to the prior week's 1,113.`
*(Note: Prior week comparison is only included if the SQL returns it; the model is instructed not to invent numbers.)*

**Input:** "Show DAU for the last 30 days"
**Result:** time series with a dip on weekends
**Narration:** `Daily active users averaged 3,840 over the past month, with a consistent weekday/weekend pattern: weekday DAU averaged 4,600 vs. 2,300 on weekends.`

---

## 5. Evaluation Criteria

### 5.1 SQL Correctness

Evaluated on a labeled test set of 200 NL/SQL pairs, scored on:

| Metric | Method | Target |
|---|---|---|
| **Exact match** | String equality after normalization | 45% |
| **Execution equivalence** | Same result set on canonical dataset | 82% |
| **Schema adherence** | No hallucinated column/table names | 99% |
| **Scope correctness** | project_id always present | 100% |
| **Parse success** | SQL is valid DuckDB syntax | 99% |

### 5.2 Narration Quality

Evaluated via human preference study (n=50 queries × 3 raters):

| Criterion | Scale | Target |
|---|---|---|
| Accuracy (no invented numbers) | 1–5 | ≥ 4.5 |
| Conciseness (no padding) | 1–5 | ≥ 4.0 |
| Actionability (insight over description) | 1–5 | ≥ 3.5 |

### 5.3 Regression Suite

All curated few-shot examples are part of the automated regression suite (`packages/api/src/ai/__tests__/sql-generator.test.ts`). Tests run on every PR and compare:
1. SQL parse succeeds.
2. Tables and columns match the expected schema.
3. `project_id` binding is present.
4. `suggestedChartType` matches the expected type for that query pattern.

---

## 6. Model Routing & Cost Control

| Query complexity | Model | Approx. cost/query |
|---|---|---|
| Simple (1 aggregation, no joins) | gpt-4o-mini | ~$0.0002 |
| Medium (group by, time filter) | gpt-4o-mini | ~$0.0004 |
| Complex (funnel, cohort, window fn) | gpt-4o | ~$0.003 |
| Narration (always) | gpt-4o-mini | ~$0.0002 |

Complexity is estimated heuristically before calling the LLM:
- Keywords: "funnel", "cohort", "retention", "compared to" → gpt-4o
- Single metric questions → gpt-4o-mini

Monthly cost estimate for 1,000 queries/day: ~$15–40 USD.

---

## 7. Prompt Versioning

Prompts are versioned with the `AI_PROMPT_VERSION` env var (e.g., `v3`). Each version is stored in `packages/api/src/ai/prompts/`. The active prompt version is logged with every query execution to `saved_queries.ai_model` for retrospective analysis.

When updating prompts:
1. Create a new version file (`sql-generator.v4.ts`).
2. Run the regression suite against both `v3` and `v4`.
3. A/B test on 10% of traffic with the `AI_PROMPT_VERSION=v4` env override.
4. Promote when v4 execution-equivalence score exceeds v3 by > 2pp.
