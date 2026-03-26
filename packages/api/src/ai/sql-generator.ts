import OpenAI from "openai";
import { Parser } from "node-sql-parser";
import type { AIQueryRequest, AIQueryResponse, ChartType } from "@copilot/shared";

const client = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
const parser = new Parser();

const PROMPT_VERSION = process.env["AI_PROMPT_VERSION"] ?? "v1";

// ─── Schema Types ─────────────────────────────────────────────────────────────

interface ProjectSchema {
  projectId: string;
  projectName: string;
  eventNames: string[];
  propertySchema: Record<string, string>;
}

// ─── Generated SQL Response ───────────────────────────────────────────────────

interface GeneratedSQL {
  answerable: boolean;
  sql: string | null;
  explanation: string;
  assumptions: string[];
  confidence: number;
  suggestedChartType: ChartType;
  model: string;
  promptVersion: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

// ─── Column definitions for the system prompt ─────────────────────────────────

const EVENT_COLUMNS = [
  { name: "id", type: "UUID", description: "Row identifier" },
  { name: "project_id", type: "VARCHAR", description: "Tenant isolation key — ALWAYS include in WHERE clause" },
  { name: "event_name", type: "VARCHAR", description: "Name of the event (e.g., 'user_signed_up')" },
  { name: "user_id", type: "VARCHAR", description: "Your product's user identifier" },
  { name: "anonymous_id", type: "VARCHAR", description: "Pre-identification anonymous ID" },
  { name: "session_id", type: "VARCHAR", description: "Session identifier" },
  { name: "timestamp", type: "TIMESTAMPTZ", description: "Canonical event time — USE THIS for time filtering" },
  { name: "received_at", type: "TIMESTAMPTZ", description: "Server receipt time — do not use for analysis" },
  { name: "country_code", type: "VARCHAR(2)", description: "ISO 3166-1 alpha-2 country code" },
  { name: "device_type", type: "VARCHAR", description: "'desktop' | 'mobile' | 'tablet'" },
  { name: "app_version", type: "VARCHAR", description: "App version string (mobile only)" },
  { name: "properties", type: "JSON", description: "Arbitrary event properties — access with json_extract_string(properties, '$.key')" },
];

// ─── System Prompt Builder ────────────────────────────────────────────────────

function buildSystemPrompt(schema: ProjectSchema): string {
  const columnDefs = EVENT_COLUMNS.map((c) => `  - ${c.name} (${c.type}): ${c.description}`).join("\n");

  const eventNamesList = schema.eventNames.slice(0, 60).map((e) => `  - "${e}"`).join("\n");

  const topProperties = Object.entries(schema.propertySchema)
    .slice(0, 40)
    .map(([k, t]) => `  - "${k}" (${t})`)
    .join("\n");

  return `You are an expert DuckDB SQL analyst embedded in a product analytics platform called Product Analytics Copilot.

Your job is to convert a natural language question about user behavior into a valid DuckDB SQL query.

## Database Schema

Table: events
Columns:
${columnDefs}

Known event names for this project:
${eventNamesList || "  (no events tracked yet)"}

Frequently used property keys (from \`properties\` JSON column):
${topProperties || "  (no properties tracked yet)"}

## Rules

1. ALWAYS include \`WHERE project_id = '${schema.projectId}'\` in every query.
2. NEVER generate INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE, or any DDL/DML.
3. NEVER reference tables other than \`events\`, \`mv_daily_active_users\`, or \`mv_event_volume\`.
4. Use \`timestamp\` for ALL time-based filtering.
5. Convert relative time references using DuckDB interval syntax: \`timestamp >= now() - INTERVAL '7 days'\`.
6. For "active users", use \`count(distinct user_id)\`.
7. For funnel analysis, use CTEs with self-joins or window functions — do NOT use PIVOT.
8. Access JSON properties with: \`json_extract_string(properties, '$.key')\` or \`json_extract(properties, '$.key')::FLOAT\` for numbers.
9. If the question is ambiguous, make the most reasonable interpretation and note it in \`assumptions\`.
10. If the question CANNOT be answered with the available schema, set \`answerable\` to false.
11. Use DuckDB syntax ONLY. Do not use PostgreSQL-specific functions.

## Few-Shot Examples

### Example 1: Simple count
User: How many sign-up events happened this week?
Response: {"answerable":true,"sql":"SELECT count(*) AS signups FROM events WHERE project_id = '${schema.projectId}' AND event_name = 'user_signed_up' AND timestamp >= date_trunc('week', now())","explanation":"Counts all sign-up events since the start of the current calendar week.","assumptions":["'This week' is interpreted as starting Monday."],"confidence":0.97,"suggestedChartType":"metric"}

### Example 2: DAU trend
User: Show me DAU for the past 30 days
Response: {"answerable":true,"sql":"SELECT date_trunc('day', timestamp) AS date, count(distinct user_id) AS dau FROM events WHERE project_id = '${schema.projectId}' AND timestamp >= now() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1","explanation":"Returns unique users per day for the last 30 days.","assumptions":[],"confidence":0.99,"suggestedChartType":"line"}

### Example 3: Property segmentation
User: Break down signups by plan type last month
Response: {"answerable":true,"sql":"SELECT json_extract_string(properties, '$.plan') AS plan, count(*) AS signups FROM events WHERE project_id = '${schema.projectId}' AND event_name = 'user_signed_up' AND timestamp >= date_trunc('month', now()) - INTERVAL '1 month' AND timestamp < date_trunc('month', now()) GROUP BY 1 ORDER BY 2 DESC","explanation":"Groups sign-up events by the plan property for the previous calendar month.","assumptions":["Plan extracted from properties.plan key."],"confidence":0.91,"suggestedChartType":"bar"}

## Output Format

Respond with ONLY a JSON object (no markdown fences) matching:
{
  "answerable": boolean,
  "sql": string | null,
  "explanation": string,
  "assumptions": string[],
  "confidence": number (0.0–1.0),
  "suggestedChartType": "line" | "bar" | "area" | "pie" | "metric" | "funnel" | "table" | "heatmap"
}`;
}

// ─── SQL Validator ────────────────────────────────────────────────────────────

interface ValidationResult {
  valid: boolean;
  sql: string;
  reason?: string;
}

function validateSQL(sql: string, projectId: string): ValidationResult {
  // 1. Parse the SQL
  let ast: ReturnType<Parser["astify"]>;
  try {
    ast = parser.astify(sql, { database: "DuckDB" });
  } catch {
    // Try generic SQL parse as fallback
    try {
      ast = parser.astify(sql);
    } catch {
      return { valid: false, sql, reason: "SQL parse error — invalid syntax" };
    }
  }

  // 2. Must be a SELECT statement
  const stmts = Array.isArray(ast) ? ast : [ast];
  for (const stmt of stmts) {
    if (stmt.type !== "select") {
      return { valid: false, sql, reason: `Disallowed statement type: ${stmt.type}` };
    }
  }

  // 3. Ensure project_id is referenced
  if (!sql.toLowerCase().includes(`project_id`)) {
    // Inject it as a belt-and-suspenders measure
    const injected = sql.replace(/\bWHERE\b/i, `WHERE project_id = '${projectId}' AND`);
    if (injected === sql) {
      // No WHERE clause — append one
      return {
        valid: true,
        sql: `${sql} WHERE project_id = '${projectId}'`,
      };
    }
    return { valid: true, sql: injected };
  }

  return { valid: true, sql };
}

// ─── Model Selection ──────────────────────────────────────────────────────────

function selectModel(question: string): string {
  const complexKeywords = /funnel|cohort|retention|compare|versus|vs\.|segment|breakdown by.*and/i;
  if (complexKeywords.test(question)) {
    return process.env["OPENAI_MODEL_COMPLEX"] ?? "gpt-4o";
  }
  return process.env["OPENAI_MODEL_SIMPLE"] ?? "gpt-4o-mini";
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function generateSQL(
  request: AIQueryRequest,
  schema: ProjectSchema
): Promise<GeneratedSQL> {
  const model = selectModel(request.question);
  const systemPrompt = buildSystemPrompt(schema);

  const userMessage = `Project: ${schema.projectName}
Time range: ${request.timeRange ?? "30d"}${request.startDate ? ` (${request.startDate} to ${request.endDate})` : ""}

Question: ${request.question}`;

  const start = Date.now();

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_tokens: 1024,
  });

  const latencyMs = Date.now() - start;

  const raw = response.choices[0]?.message?.content ?? "{}";
  let parsed: Partial<GeneratedSQL>;

  try {
    parsed = JSON.parse(raw) as Partial<GeneratedSQL>;
  } catch {
    return {
      answerable: false,
      sql: null,
      explanation: "Failed to parse AI response. Please try rephrasing your question.",
      assumptions: [],
      confidence: 0,
      suggestedChartType: "table",
      model,
      promptVersion: PROMPT_VERSION,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      latencyMs,
    };
  }

  // Validate and sanitize the generated SQL
  let finalSql = parsed.sql ?? null;
  if (finalSql && parsed.answerable !== false) {
    const validation = validateSQL(finalSql, request.projectId);
    if (!validation.valid) {
      return {
        answerable: false,
        sql: null,
        explanation: `Generated SQL failed validation: ${validation.reason}`,
        assumptions: [],
        confidence: 0,
        suggestedChartType: "table",
        model,
        promptVersion: PROMPT_VERSION,
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        latencyMs,
      };
    }
    finalSql = validation.sql;
  }

  return {
    answerable: parsed.answerable ?? true,
    sql: finalSql,
    explanation: parsed.explanation ?? "",
    assumptions: parsed.assumptions ?? [],
    confidence: parsed.confidence ?? 0.5,
    suggestedChartType: (parsed.suggestedChartType as ChartType) ?? "table",
    model,
    promptVersion: PROMPT_VERSION,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

// ─── Result Narration ─────────────────────────────────────────────────────────

export async function narrateResult(
  question: string,
  sql: string,
  rows: Record<string, unknown>[],
  rowCount: number
): Promise<string> {
  const sampleRows = rows.slice(0, 5);

  const response = await client.chat.completions.create({
    model: process.env["OPENAI_MODEL_SIMPLE"] ?? "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a data analyst summarizing query results for a product team.

Given a question, SQL, and result sample, write 1–3 concise sentences that:
1. Directly answer the question with the key number(s).
2. Highlight the most interesting trend or comparison in the data.
3. Use plain language — no SQL jargon, no "the data shows", no markdown.

Respond with plain text only.`,
      },
      {
        role: "user",
        content: `Question: ${question}

SQL: ${sql}

Result sample (first 5 rows):
${JSON.stringify(sampleRows, null, 2)}

Total row count: ${rowCount}`,
      },
    ],
    temperature: 0.3,
    max_tokens: 200,
  });

  return response.choices[0]?.message?.content?.trim() ?? "";
}
