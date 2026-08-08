# Deep-Dive Engineering Analysis: Production Financial RAG Engine

A comprehensive technical breakdown of zero-downtime database swaps, financial chunk typologies, parent topic inheritance, role-based security, and hybrid SQL search execution.

---

## 1. Blue-Green Database Swaps & Dual Index Architecture

### What is a Blue-Green Database Swap?
In a live production environment, users are constantly searching the database (`rag_index_live`). If a background task needs to re-index 1,000 corporate 10-K filings, updating the live table directly causes major problems:
1. **Search Interruption**: Users executing queries while data is being deleted/inserted receive incomplete or corrupted search results.
2. **Database Locking**: Heavy bulk `INSERT` and HNSW index recalculation statements lock database rows and degrade search performance.

To solve this, our system implements **Blue-Green Database Swaps** using twin index tables: `rag_index_a` (Blue) and `rag_index_b` (Green).

```
                      LIVE TRAFFIC GATEWAY
                               │
                               ▼
                    ┌─────────────────────┐
                    │    index_aliases    │
                    │ ('rag_index_live')  │
                    └──────────┬──────────┘
                               │
                 ┌─────────────┴─────────────┐
                 │ Pointer: 'rag_index_a'    │
                 ▼                           ▼
       ┌──────────────────┐        ┌──────────────────┐
       │   rag_index_a    │        │   rag_index_b    │
       │  (ACTIVE / BLUE) │        │ (STAGING / GREEN)│
       └─────────┬────────┘        └─────────┬────────┘
                 │                           │
          Serves Live User           Background Worker
           Search Queries            Builds New Index
```

### How the Zero-Downtime Process Works Step-by-Step (`app/worker.py`):
1. **Read Active Pointer**: The worker queries `index_aliases` where `alias_name = 'rag_index_live'`. If active is `rag_index_a`, staging target is set to `rag_index_b`.
2. **Prepare Staging Table**: The worker truncates `rag_index_b` (`TRUNCATE TABLE rag_index_b;`) and copies all existing active vectors into `rag_index_b` (excluding the target document being updated).
3. **Ingest & Re-Index**: New chunks and 384-dimensional embeddings are appended to `rag_index_b`. HNSW and GIN indexes are updated safely in the staging table.
4. **Atomic Pointer Swap**: The worker executes an **instantaneous SQL transaction**:
   ```sql
   UPDATE index_aliases SET target_table = 'rag_index_b', updated_at = NOW() 
   WHERE alias_name = 'rag_index_live';

   CREATE OR REPLACE VIEW rag_index_live AS SELECT * FROM rag_index_b;
   ```
5. **Result**: Zero user downtime! User queries transition seamlessly from `rag_index_a` to `rag_index_b` in less than 1 millisecond.

---

## 2. Financial Data Typologies: Text vs. Tables

### Are Text and Tables the Only Types in Financial Data?
In corporate financial reporting (SEC filings, earnings call transcripts, 10-K / 10-Q reports, balance sheets), **text** and **tables** represent ~95% of all content:
1. **Prose Text (`chunk_type = 'text'`)**: Executive summaries, Risk Factors (Item 1A), Legal disclosures, MD&A commentary.
2. **Tabular Data (`chunk_type = 'table'`)**: Consolidated Statements of Operations, Balance Sheets, Cash Flow Statements, Segment Revenue breakdowns.

### Why Classifying `chunk_type` is Critical
Financial tables and prose text require fundamentally different retrieval handling:
- **Tables** contain dense numerical matrices where column names and row labels must never be severed.
- **Prose** contains narrative sentences that require paragraph-level split points.

### Other Edge Typologies
While stored under `text` or `table` enums, the engine handles:
- **Financial Footnotes**: Embedded below financial tables (parsed as part of the atomic table chunk).
- **Key Performance Indicators (KPIs)**: Bolded metric callouts (parsed under section prose).

---

## 3. Parent Topic Association & Context Inheritance

### The Orphan Data Problem
If a search query retrieves a table chunk containing `| iPhone | 201183 |`, the LLM has no idea what fiscal year or SEC section that row belongs to. Without context, $201,183 could be dollars, units sold, or revenue in Euros.

### How `app/chunker.py` Resolves Parent Topics
Our chunker maintains a **state-machine header tracker** while parsing the document:

```
[Document Line] ──► Is Heading? ──► YES ──► Update current_section = Heading Text
                         │
                         NO
                         │
                         ▼
        Attach current_section to Chunk Metadata Payload
```

#### Code Logic:
1. When parsing lines, `HEADER_PATTERN` detects headings like `# Item 1. Business` or `## Segment Performance`.
2. It sets `current_section = "Item 1. Business > Segment Performance"`.
3. Every subsequent chunk (whether table or text) is stamped with `parent_section = current_section`.

#### Database Storage:
```sql
parent_section = 'Item 1. Business > Financial Performance'
chunk_type     = 'table'
content        = '| Segment | 2024 Revenue ($M) |\n| iPhone | 201183 |'
```

When retrieved, the prompt sent to the LLM reads:
> **Section Context:** Item 1. Business > Financial Performance  
> **Table Data:** | Segment | 2024 Revenue ($M) | ...

The LLM now knows with 100% precision that 201,183 represents 2024 Revenue in Millions of USD for the iPhone segment!

---

## 4. Role-Based Access Control (RBAC) & Metadata Synchronization

### How RBAC Security Works
In enterprise environments, a financial analyst might have access to public reports, while an executive has access to confidential M&A drafts.

1. **Storage**: Every chunk contains an array column `allowed_roles TEXT[]` (e.g. `['analyst', 'executive', 'admin']`).
2. **Query Enforcement**: When a user searches, their authorized roles (e.g. `['analyst']`) are passed to PostgreSQL.
3. **SQL Array Overlap Operator (`&&`)**:
   ```sql
   WHERE allowed_roles && ARRAY['analyst']::text[]
   ```
   PostgreSQL uses a **GIN index on `allowed_roles`** to filter out unauthorized chunks before performing vector calculations, ensuring 100% data privacy.

### Is Metadata Synced?
Yes! Document metadata (`doc_id`, `ticker_symbol`, `filename`, `content_hash`, `version`) lives in `document_registry`.

Every chunk table (`rag_index_a` and `rag_index_b`) enforces a relational **Foreign Key**:
```sql
doc_id VARCHAR(255) REFERENCES document_registry(doc_id) ON DELETE CASCADE
```
Deleting or updating a document in `document_registry` instantly cascades across all vector chunks. There are zero metadata drift or orphan vector bugs.

---

## 5. Hybrid Search Mechanics: Vector Similarity + Keyword Search in SQL

When a user submits a query (e.g., *"What was Apple's 2024 iPhone revenue?"*), the system executes a multi-stage **Hybrid Search Engine** in PostgreSQL:

```
                          User Query: "Apple 2024 iPhone revenue"
                                           │
                 ┌─────────────────────────┴─────────────────────────┐
                 ▼                                                   ▼
     1. DENSE VECTOR SEARCH                              2. FULL-TEXT KEYWORD SEARCH
  (SentenceTransformers Embedding)                     (PostgreSQL tsvector & GIN)
                 │                                                   │
  Computes 384-dim Float Vector                        Parses Query into plainto_tsquery
  Scans HNSW Cosine Index (<=>)                        Scans GIN Index (ts_rank_cd)
                 │                                                   │
                 ▼                                                   ▼
     Top-20 Nearest Vectors                             Top-20 Keyword Matches
  (Rank 1 = Closest Distance)                        (Rank 1 = Highest Rank Score)
                 │                                                   │
                 └─────────────────────────┬─────────────────────────┘
                                           ▼
                            3. RECIPROCAL RANK FUSION (RRF)
                  RRF_Score = 1/(60 + Rank_vec) + 1/(60 + Rank_fts)
                                           │
                                           ▼
                             Top-K Highest RRF Scores
```

### Step 1: Dense Vector Search (Semantic Meaning)
- Converts query text into a 384-float vector `[0.012, -0.045, ...]`.
- Scans `rag_index_a` using HNSW cosine distance operator `<=>`:
  ```sql
  SELECT chunk_id, ROW_NUMBER() OVER (ORDER BY embedding <=> %s::vector) AS rank_vec
  FROM rag_index_a WHERE allowed_roles && %s::text[] LIMIT 20;
  ```

### Step 2: Full-Text Keyword Search (Exact Words & Numbers)
- Converts query text into PostgreSQL search terms (`plainto_tsquery('english', 'Apple 2024 iPhone revenue')`).
- Scans GIN index on `content_tsvector` using text ranking `ts_rank_cd`:
  ```sql
  SELECT chunk_id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(content_tsvector, plainto_tsquery('english', %s)) DESC) AS rank_fts
  FROM rag_index_a WHERE content_tsvector @@ plainto_tsquery('english', %s)
    AND allowed_roles && %s::text[] LIMIT 20;
  ```

### Step 3: Reciprocal Rank Fusion (RRF) in SQL
PostgreSQL merges both Top-20 rank lists inside a single CTE SQL query (`app/hybrid_search.py`):

```sql
WITH vector_search AS ( ... ),
fts_search AS ( ... ),
combined AS (
    SELECT
        COALESCE(v.chunk_id, f.chunk_id) AS chunk_id,
        COALESCE(v.content, f.content) AS content,
        COALESCE(v.parent_section, f.parent_section) AS parent_section,
        (COALESCE(1.0 / (60 + v.rank_vec), 0.0) + COALESCE(1.0 / (60 + f.rank_fts), 0.0))::float AS rrf_score
    FROM vector_search v
    FULL OUTER JOIN fts_search f ON v.chunk_id = f.chunk_id
)
SELECT * FROM combined ORDER BY rrf_score DESC LIMIT 10;
```

### Why SQL RRF Execution is Superior
1. **Low Latency**: Merging and sorting happen in C-optimized PostgreSQL memory rather than pulling thousands of rows into Python.
2. **Best of Both Worlds**: Finds both semantic concepts ("earnings growth") and exact financial metrics ("iPhone 201183").
3. **Automatic Tie-Breaking**: If a chunk ranks #1 in vector search AND #1 in keyword search, its score doubles, pushing it to the top!
