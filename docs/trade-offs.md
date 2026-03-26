# Architectural Trade-offs

This document records significant design decisions made during the initial architecture phase. Each entry uses an Option A / Option B format with the rationale for the chosen path. Revisit these as usage patterns emerge.

---

## 1. Storage Engine: DuckDB (Embedded) vs. ClickHouse (Separate Service)

### Option A — DuckDB embedded in the API process ✅ Chosen

- **Pros:**
  - Zero operational overhead — no separate service to provision, monitor, or backup separately.
  - Reads are in-process (no network hop); 10M-row aggregations complete in ~80ms.
  - Parquet-native: can attach S3 Parquet files for cold queries without a migration.
  - Single binary deployment (`api` container includes DuckDB FFI).
  - Schema changes are just SQL `ALTER TABLE`; no distributed schema coordination.

- **Cons:**
  - Single-writer constraint: concurrent event ingestion must be serialised through one writer thread.
  - No built-in replication; HA requires external volume snapshots or WAL streaming.
  - Less battle-tested at 1B+ rows than ClickHouse.
  - DuckDB v1.0 released 2024 — younger ecosystem, fewer BI connectors.

### Option B — ClickHouse (separate container/managed)

- **Pros:**
  - Excellent at 100M–10B rows; MergeTree engine handles high-ingest well.
  - Mature replication (Keeper / ZooKeeper).
  - Rich ecosystem (Grafana plugin, dbt adapter, MetaBase).
- **Cons:**
  - Requires a separate ClickHouse container or managed service (Tinybird, ClickHouse Cloud).
  - TCP connection, driver overhead, and network latency add ~5–20ms to every query.
  - Steeper operational learning curve; harder to run locally for development.
  - Overkill for < 50M rows.

**Decision:** DuckDB for now. We export Parquet to S3 nightly; if we outgrow DuckDB, ClickHouse can ingest those same Parquet files with near-zero ETL work. The interface contract (SQL over a single `events` table) is identical.

**Trigger to re-evaluate:** Sustained ingest > 10,000 events/sec, or hot dataset > 50GB.

---

## 2. Frontend State Management: Zustand + React Query vs. Redux Toolkit

### Option A — Zustand (UI state) + TanStack Query (server state) ✅ Chosen

- **Pros:**
  - Clear separation of concerns: React Query owns all async data; Zustand owns ephemeral client state (selected panel, sidebar open, draft query text).
  - No boilerplate for actions/reducers/selectors for server data.
  - React Query's cache invalidation (`queryClient.invalidateQueries`) is purpose-built for our patterns (dashboard refresh after query save).
  - Bundle size: ~12KB (Zustand) + ~40KB (RQ) vs. ~80KB (RTK + RTK Query).
  - Zustand stores are plain functions — easy to test without `Provider` wrappers.

- **Cons:**
  - Two state libraries to reason about — developers must know which category of state goes where.
  - No Redux DevTools time-travel for server state (React Query DevTools cover most of this).
  - Cross-store derived state requires `useShallow` or manual selectors.

### Option B — Redux Toolkit (RTK) + RTK Query

- **Pros:**
  - Single paradigm for all state.
  - RTK Query's code generation from OpenAPI is compelling for typed API clients.
  - Redux DevTools ecosystem is mature.
- **Cons:**
  - RTK Query and React Query have equivalent feature sets, but RTK adds serialization constraints that conflict with non-serializable values (DuckDB result buffers, Date objects).
  - More boilerplate per slice, even with RTK's `createSlice`.
  - Team consensus in 2024 has moved away from Redux for server state.

**Decision:** Zustand + React Query. The constraint "Zustand for UI, React Query for server" is a one-sentence rule that eliminates most ambiguity.

---

## 3. AI Provider Abstraction: Direct OpenAI SDK vs. Provider-Agnostic Adapter

### Option A — Direct OpenAI SDK with a thin wrapper ✅ Chosen

Structure:
```
ai-layer/
  llm-client.ts        # thin wrapper: model, retries, token counting
  sql-generator.ts     # prompt assembly + sql generation
  result-summarizer.ts # narrate query results
```

- **Pros:**
  - Full control over request shape (tool definitions, structured outputs, streaming).
  - OpenAI's `response_format: { type: "json_schema" }` structured output is used for SQL extraction — not available through most abstraction layers yet.
  - Simpler debugging: `console.log(request)` shows exactly what is sent.
  - No extra dependency surface area.

- **Cons:**
  - Switching to Anthropic Claude or local Ollama requires changing `llm-client.ts`.
  - Code duplication if we later add multiple AI features with different models.

### Option B — LangChain / Vercel AI SDK as abstraction layer

- **Pros:**
  - Provider-agnostic: swap OpenAI → Anthropic by changing config.
  - Vercel AI SDK's `useChat` / `useCompletion` hooks integrate well with React.
  - LangChain's retrieval chains are useful if we add RAG over documentation.
- **Cons:**
  - Vercel AI SDK is optimized for streaming chat UX, not structured JSON extraction.
  - LangChain abstracts away prompt internals, making debugging harder.
  - Both add meaningful bundle size and dependency churn risk.

**Decision:** Direct SDK with a typed `LLMClient` interface. The interface has `generateSQL()` and `summarizeResult()` — replacing the implementation requires changing one file. We will not abstract before we have a second provider.

---

## 4. Query Caching Strategy: In-Process LRU vs. Redis

### Option A — In-process LRU cache (node-lru-cache) ✅ Chosen for v1

- **Pros:**
  - Zero infrastructure — no Redis container.
  - Sub-millisecond cache hits (memory lookup).
  - Cache key: `SHA256(sql + project_id + date_trunc)`.
  - 200MB LRU eviction keeps common dashboard queries warm.

- **Cons:**
  - Cache is not shared across API server instances (not relevant for single-process v1, blocking for horizontal scale).
  - Cache lost on process restart.
  - No TTL-based invalidation across clients — a new event won't bust the cache until TTL expires.

### Option B — Redis with structured cache keys

- **Pros:**
  - Shared across API replicas.
  - `KEYS events:project:X:*` pattern allows project-scoped invalidation on new ingest.
  - Persistent (RDB snapshots) — warm cache survives restart.
  - Fine-grained TTL per query type (5min for dashboards, 1hr for cohort queries).
- **Cons:**
  - Additional container, operational overhead.
  - Network RTT adds ~1–3ms per cache hit.

**Decision:** LRU in-process for v1. The Redis migration path is documented in `scalability.md`. The cache key scheme is identical between implementations — switching requires changing one module.

**Trigger to re-evaluate:** Second API server instance, or cache invalidation bugs from stale dashboard data.

---

## 5. Real-time Updates: WebSocket Push vs. Polling

### Option A — WebSocket push for long-running queries ✅ Chosen

Pattern: AI-generated queries are submitted async. API returns a `queryId` immediately; DuckDB executes in a worker; result is pushed via WebSocket when done.

- **Pros:**
  - Clean UX: spinner → result without client polling.
  - Enables future features: live event counter, streaming AI narration.
  - Connection reused across multiple queries in a session.
  - `ws` library is mature and lightweight.

- **Cons:**
  - Load balancers require sticky sessions or a shared pub/sub channel (Redis) for multi-instance.
  - More complex error handling (disconnects, reconnect logic in the client).
  - Overkill for queries that complete in < 200ms.

### Option B — HTTP polling (`GET /v1/queries/:id/status`)

- **Pros:**
  - Dead-simple implementation — works through any proxy.
  - No connection state to manage.
  - Easy to debug with `curl`.
- **Cons:**
  - Adds latency: if polling interval is 1s, average added latency is 500ms.
  - Creates thundering herd if many users have dashboards open simultaneously.

**Decision:** WebSocket for the AI query flow. Standard REST for everything else (saved queries, dashboard CRUD, ingest). Polling is offered as a fallback for environments where WebSocket is blocked (some corporate proxies).

---

## 6. Multi-tenancy: Row-Level Filtering vs. Separate DuckDB Files per Project

### Option A — Single DuckDB file with `project_id` column ✅ Chosen

All events share one `events` table. Every query binds `AND project_id = $1`.

- **Pros:**
  - Simpler to manage: one backup, one vacuum, one schema migration.
  - Cross-project queries possible for future "portfolio analytics" feature.
  - DuckDB partition pruning on `project_id` is efficient (zone maps).

- **Cons:**
  - A bug that omits the `project_id` filter leaks data across tenants.
  - Large projects affect DuckDB file size for all tenants.

### Option B — One DuckDB file per project

- **Pros:**
  - Hard isolation: a misconfigured query cannot leak cross-project.
  - Can archive/delete a project by deleting a file.
- **Cons:**
  - N open file descriptors and N memory allocations for N active projects.
  - Schema migrations must be applied to each file individually.
  - DuckDB in-process; opening 100 connections is feasible, 1000 is not.

**Decision:** Single file with `project_id` for v1. Mitigation: `project_id` is injected by the API layer (never trusted from query params or AI output). The SQL validator rejects any query that attempts to remove the project binding.

---

## 7. Bonus — Event Schema: Strict Schema vs. Schema-on-Read (schemaless `properties` JSON)

### Option A — `properties JSONB` with schema-on-read ✅ Chosen

Core columns (`user_id`, `event_name`, `timestamp`, `session_id`, `project_id`) are typed. All other properties are stored in a `properties JSON` column.

- **Pros:**
  - SDKs can track arbitrary properties without a schema migration.
  - DuckDB's `json_extract_string(properties, '$.plan')` is well-optimised.
  - Matches how Segment, Mixpanel, and Amplitude work — familiar to practitioners.

- **Cons:**
  - No compile-time type safety on properties.
  - JSON extraction is slower than typed columns for high-cardinality property queries.
  - Auto-complete in the query builder requires a separate schema inference pass.

### Option B — Strict typed columns, schema registry

- **Pros:**
  - Columnar compression is maximally effective on typed columns.
  - Queries are faster and type-safe.
- **Cons:**
  - Schema changes require SDK updates + API migration + DuckDB `ALTER TABLE`.
  - Blocks rapid prototyping of new event types.

**Decision:** Schemaless `properties` with the option to "promote" high-cardinality properties to typed columns later via `ALTER TABLE ADD COLUMN` + a background migration. This mirrors Amplitude's schema-on-write upgrade path.
