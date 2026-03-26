// ─── Core Domain Types ───────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: WorkspacePlan;
  createdAt: string;
  updatedAt: string;
}

export type WorkspacePlan = "starter" | "pro" | "enterprise";

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  color?: string;
  eventNames: string[];
  propertySchema: Record<string, "string" | "number" | "boolean">;
  lastSchemaRefresh?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  preferences: UserPreferences;
  createdAt: string;
  lastActiveAt?: string;
}

export interface UserPreferences {
  theme: "light" | "dark" | "system";
  defaultTimeRange: TimeRange;
  defaultChartType: ChartType;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  user: Pick<User, "id" | "email" | "name" | "avatarUrl">;
  role: MemberRole;
  invitedAt: string;
  acceptedAt?: string;
}

export type MemberRole = "owner" | "editor" | "viewer";

// ─── Analytics Event ─────────────────────────────────────────────────────────

export interface AnalyticsEvent {
  id: string;
  projectId: string;
  eventName: string;
  eventUuid: string;
  userId: string;
  anonymousId?: string;
  sessionId?: string;
  receivedAt: string;
  sentAt?: string;
  timestamp: string;
  ipAddress?: string;
  countryCode?: string;
  city?: string;
  deviceType?: "desktop" | "mobile" | "tablet";
  osName?: string;
  browserName?: string;
  appVersion?: string;
  properties: Record<string, unknown>;
  ingestBatchId?: string;
  schemaVersion: number;
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

export interface IngestBatch {
  batch: IngestEvent[];
}

export interface IngestEvent {
  event: string;
  userId?: string;
  anonymousId?: string;
  sessionId?: string;
  timestamp?: string;
  sentAt?: string;
  context?: EventContext;
  properties?: Record<string, unknown>;
}

export interface EventContext {
  ip?: string;
  locale?: string;
  userAgent?: string;
  page?: { url?: string; path?: string; title?: string; referrer?: string };
  device?: { type?: string; manufacturer?: string; model?: string };
  os?: { name?: string; version?: string };
  app?: { name?: string; version?: string };
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  batchId: string;
  rejectionReasons?: Record<string, number>;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export interface SavedQuery {
  id: string;
  projectId: string;
  createdBy: string;
  title: string;
  description?: string;
  nlQuestion?: string;
  sql: string;
  aiGenerated: boolean;
  aiModel?: string;
  aiConfidence?: number;
  aiExplanation?: string;
  lastRunAt?: string;
  lastRunMs?: number;
  lastRowCount?: number;
  version: number;
  isDraft: boolean;
  chartType: ChartType;
  chartConfig: ChartConfig;
  timeRange: TimeRange;
  createdAt: string;
  updatedAt: string;
}

export type ChartType = "line" | "bar" | "area" | "pie" | "metric" | "funnel" | "table" | "heatmap";

export type TimeRange = "1d" | "7d" | "14d" | "30d" | "90d" | "180d" | "365d" | "custom";

export interface ChartConfig {
  xAxis?: string;
  yAxis?: string[];
  groupBy?: string;
  colorScheme?: string;
  showLegend?: boolean;
  fillOpacity?: number;
}

// ─── Query Execution ─────────────────────────────────────────────────────────

export interface QueryResult {
  queryId: string;
  sql: string;
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
  cached: boolean;
  truncated: boolean;
}

export interface QueryColumn {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "json";
}

// ─── AI ──────────────────────────────────────────────────────────────────────

export interface AIQueryRequest {
  question: string;
  projectId: string;
  timeRange?: TimeRange;
  startDate?: string;
  endDate?: string;
}

export interface AIQueryResponse {
  queryId: string;
  sql: string | null;
  explanation: string;
  assumptions: string[];
  confidence: number;
  suggestedChartType: ChartType;
  answerable: boolean;
  result?: QueryResult;
  summary?: string;
  executionMs?: number;
}

export interface AIGenerationMeta {
  model: string;
  promptVersion: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

// ─── Dashboards ──────────────────────────────────────────────────────────────

export interface Dashboard {
  id: string;
  projectId: string;
  createdBy: string;
  title: string;
  description?: string;
  emoji: string;
  layout: DashboardWidgetLayout[];
  widgets: DashboardWidget[];
  isPublic: boolean;
  publicToken?: string;
  refreshIntervalSeconds?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardWidgetLayout {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardWidget {
  id: string;
  dashboardId: string;
  savedQueryId?: string;
  savedQuery?: Pick<SavedQuery, "id" | "title" | "sql" | "chartType" | "chartConfig">;
  widgetType: "chart" | "metric" | "text" | "image" | "divider";
  content?: string;
  titleOverride?: string;
  chartTypeOverride?: ChartType;
  chartConfigOverride?: ChartConfig;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
}

// ─── API Response Wrappers ────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
  details?: unknown;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  };
}

// ─── WebSocket Messages ───────────────────────────────────────────────────────

export type WSMessage =
  | { type: "query.started"; queryId: string }
  | { type: "query.completed"; queryId: string; result: AIQueryResponse }
  | { type: "query.failed"; queryId: string; error: string }
  | { type: "ping" }
  | { type: "pong" };
