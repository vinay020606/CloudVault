# End-to-End RAG Lifecycle: Uploading, Chunking, Indexing, Hybrid Search & LLM Synthesis

A complete architectural breakdown detailing every single micro-step from document submission to LLM natural language answer generation.

---

## 1. Master System Flowchart

```
===================================================================================================
PHASE 1: ASYNCHRONOUS INGESTION & INDEXING PIPELINE (OFFLINE / BACKGROUND)
===================================================================================================

[User / Client]
       │
       │ 1. POST /api/v1/documents/upload (Document Payload)
       ▼
[FastAPI API Gateway] ──► 2. Enqueues Task into Redis Queue ──► Returns Job ID (202 Accepted) in <1ms
                                       │
                                       ▼
                             [Redis Queue (RQ)]
                                       │
                                       ▼
                        [RQ Worker Container (app/worker.py)]
                                       │
         ┌─────────────────────────────┼─────────────────────────────┐
         ▼                             ▼                             ▼
  3. SHA-256 Gatekeeper      4. Table-Aware Chunker       5. SentenceTransformers
  Check document_registry;    Isolate <table> & |...|;      Generate 384-dim Dense
   skip if hash matches       track # parent headers        Vectors for each chunk
         │                             │                             │
         └─────────────────────────────┼─────────────────────────────┘
                                       ▼
                        6. Staging Table Ingestion (rag_index_b)
                        Insert Chunks + Build HNSW & GIN Indexes
                                       │
                                       ▼
                        7. Atomic Blue-Green Alias Swap
                        UPDATE index_aliases -> rag_index_b
                        CREATE VIEW rag_index_live AS rag_index_b
                                       │
                                       ▼
                        8. Flush L1 Redis Query Cache


===================================================================================================
PHASE 2: HYBRID SEARCH & LLM ANSWER SYNTHESIS PIPELINE (ONLINE / USER QUERY)
===================================================================================================

[User / Client]
       │
       │ 1. POST /api/v1/search (Query String, User Roles, Top-K)
       ▼
[FastAPI API Gateway]
       │
       ├──► 2. Check L1 Redis String Cache (key: query:{hash})
       │         ├── HIT  ──► Return Cached JSON Response (<2ms)
       │         └── MISS ──► Proceed to Hybrid Search
       │
       ▼
[Query Vectorizer] ──► Generate 384-dim Dense Vector for Query Text
       │
       ▼
[PostgreSQL Database (rag_index_live)]
       │
       ├──► 3. Dense Vector Search (HNSW Cosine Index: ORDER BY embedding <=> query_vector)
       ├──► 4. Full-Text Search (GIN Keyword Index: ORDER BY ts_rank_cd(...))
       ├──► 5. RBAC Filtering (WHERE allowed_roles && user_roles::text[])
       │
       ▼
[SQL RRF Fusion] ──► Merges Rankings: RRF_Score = 1/(60 + Rank_vec) + 1/(60 + Rank_fts)
       │
       ▼
[Top-K Retrieved Chunks (Tables & Text Context)]
       │
       ▼
[LLM Generation Engine (Gemini / OpenAI / Llama)]
       │
       │ 6. Constructs Augmented Context Prompt:
       │    "System: You are a financial analyst. Answer using ONLY this context:
       │     [Item 1. Business]: <Table / Text Chunks>
       │     User Query: What was Apple's 2024 iPhone revenue?"
       │
       ▼
[Final Natural Language Response] ──► "Apple's 2024 iPhone revenue was $201,183 million..."
```

---

## 2. Phase 1: Ingestion & Indexing Pipeline (Step-by-Step)

### Step 1.1: Document Upload Request
The client sends a JSON payload to `POST /api/v1/documents/upload`:
```json
{
  "doc_id": "DOC-AAPL-10K-2024",
  "ticker_symbol": "AAPL",
  "filename": "aapl_2024_10k.md",
  "content": "# Item 1. Business\nApple Inc. designs smartphones...\n| Segment | 2024 Rev ($M) |\n| iPhone | 201183 |",
  "allowed_roles": ["analyst", "admin"]
}
```

### Step 1.2: FastAPI Gateway & Redis Queue Enqueue
FastAPI receives the request, generates a unique job ID, enqueues the task into **Redis Queue (`rq`)**, and returns `HTTP 202 Accepted` in **< 1ms**:
```json
{
  "job_id": "c1f7b82e-9d22-481e-84b2-04e3abf105e1",
  "status": "queued",
  "message": "Document enqueued successfully for background processing."
}
```

### Step 1.3: RQ Worker Background Pickup
The worker container running `python -m app.worker` pops the job payload off Redis Queue asynchronously without affecting API response times.

### Step 1.4: Content Hash Verification (SHA-256 Gatekeeper)
The worker computes `hashlib.sha256(content).hexdigest()`. It queries `document_registry`:
- **If hash matches existing record:** The worker logs `"Content hash unchanged. Skipping ingestion."` and finishes early.
- **If new or modified:** It increments document `version` and continues.

### Step 1.5: Table-Aware Chunking (`app/chunker.py`)
The raw document is parsed into structured chunks:
1. **Tables:** Regex pattern `TABLE_PATTERN` isolates Markdown (`|...|`) and HTML (`<table>`) tables intact as single atomic chunks (`chunk_type="table"`).
2. **Prose & Headings:** `HEADER_PATTERN` updates `current_section = "Item 1. Business"`. Non-table text is split into ~800 character paragraph blocks (`chunk_type="text"`).

### Step 1.6: Dense Vector Embedding Generation
`SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")` embeds each chunk text string into a 384-dimensional float vector:
```python
embeddings = model.encode([chunk["content"] for chunk in chunks]).tolist()
# Output: [[0.0123, -0.0456, ..., 0.0891], ...]
```

### Step 1.7: Staging Table Ingestion (`rag_index_b`)
The worker checks `index_aliases` (`rag_index_live` $\rightarrow$ `rag_index_a`). It sets target to `rag_index_b`:
1. Truncates `rag_index_b`.
2. Copies all existing active document vectors into `rag_index_b`.
3. Inserts newly chunked & embedded document vectors into `rag_index_b`.
4. PostgreSQL updates HNSW cosine vector indexes and GIN full-text indexes in `rag_index_b`.

### Step 1.8: Atomic Blue-Green Pointer Swap
The worker executes an instantaneous SQL transaction:
```sql
UPDATE index_aliases SET target_table = 'rag_index_b', updated_at = NOW() 
WHERE alias_name = 'rag_index_live';

CREATE OR REPLACE VIEW rag_index_live AS SELECT * FROM rag_index_b;
```

### Step 1.9: L1 Redis Cache Invalidation
The worker deletes all keys matching `query:*` in Redis so subsequent search queries read fresh data from `rag_index_b`.

---

## 3. Phase 2: Hybrid Query & Retrieval Pipeline (Step-by-Step)

### Step 2.1: User Search Request
The user sends a query payload to `POST /api/v1/search`:
```json
{
  "query": "What was Apple revenue for iPhone in 2024?",
  "user_roles": ["analyst"],
  "top_k": 5
}
```

### Step 2.2: L1 Redis Cache Check
FastAPI computes SHA-256 hash of `query + roles + top_k`. Key: `query:a1b2c3...`:
- **Cache HIT:** Returns cached JSON response instantly (< 2ms) with `"cached": true`.
- **Cache MISS:** Proceeds to database retrieval engine.

### Step 2.3: Query Vector Generation
FastAPI embeds the search query string into a 384-dim vector using `SentenceTransformer`.

### Step 2.4: Hybrid RRF Search SQL Execution
PostgreSQL executes a CTE query combining **Vector Search**, **Full-Text Keyword Search**, **RBAC filtering**, and **RRF Ranking**:

```sql
WITH vector_search AS (
    SELECT chunk_id, doc_id, ticker_symbol, parent_section, content, chunk_type, allowed_roles,
           ROW_NUMBER() OVER (ORDER BY embedding <=> %s::vector) AS rank_vec
    FROM rag_index_live
    WHERE allowed_roles && %s::text[]
    LIMIT 20
),
fts_search AS (
    SELECT chunk_id, doc_id, ticker_symbol, parent_section, content, chunk_type, allowed_roles,
           ROW_NUMBER() OVER (ORDER BY ts_rank_cd(content_tsvector, plainto_tsquery('english', %s)) DESC) AS rank_fts
    FROM rag_index_live
    WHERE content_tsvector @@ plainto_tsquery('english', %s)
      AND allowed_roles && %s::text[]
    LIMIT 20
),
combined AS (
    SELECT
        COALESCE(v.chunk_id, f.chunk_id) AS chunk_id,
        COALESCE(v.doc_id, f.doc_id) AS doc_id,
        COALESCE(v.ticker_symbol, f.ticker_symbol) AS ticker_symbol,
        COALESCE(v.parent_section, f.parent_section) AS parent_section,
        COALESCE(v.content, f.content) AS content,
        COALESCE(v.chunk_type, f.chunk_type) AS chunk_type,
        COALESCE(v.allowed_roles, f.allowed_roles) AS allowed_roles,
        (COALESCE(1.0 / (60 + v.rank_vec), 0.0) + COALESCE(1.0 / (60 + f.rank_fts), 0.0))::float AS rrf_score
    FROM vector_search v
    FULL OUTER JOIN fts_search f ON v.chunk_id = f.chunk_id
)
SELECT * FROM combined ORDER BY rrf_score DESC LIMIT 5;
```

---

## 4. Phase 3: LLM Generation Pipeline (Synthesizing Natural Language Answers)

Once the Top-K relevant chunks are retrieved by the search engine, they are passed to a Generative LLM (like Google Gemini, OpenAI GPT-4, or Ollama/Llama 3) to synthesize a clear natural language answer.

### Step 3.1: Constructing the Prompt Template
The application formats the retrieved Top-K chunks into an augmented context prompt:

```text
SYSTEM INSTRUCTION:
You are an expert financial analyst assistant. Answer the user's question accurately using ONLY the provided financial document context below. If the answer cannot be determined from the context, state "Insufficient information."

RETRIEVED FINANCIAL CONTEXT:
---
[CONTEXT #1 | TYPE: TABLE | SECTION: Item 1. Business > Financial Performance]
Document ID: DOC-AAPL-10K-2024 (Ticker: AAPL)
| Segment | 2024 Revenue ($M) | 2023 Revenue ($M) |
|---|---|---|
| iPhone | 201183 | 200583 |
| Services | 96169 | 85200 |

---
[CONTEXT #2 | TYPE: TEXT | SECTION: Item 1. Business]
Document ID: DOC-AAPL-10K-2024 (Ticker: AAPL)
Apple Inc. designs, manufactures, and markets smartphones, personal computers, and wearables.

USER QUESTION:
What was Apple's total revenue for the iPhone segment in 2024?

ANSWER:
```

### Step 3.2: Complete Python Integration Code Example

Here is how simple it is to attach an LLM generation function to your FastAPI service:

```python
import google.generativeai as genai
from app.hybrid_search import execute_hybrid_rrf_search

# Configure LLM Client (e.g. Google Gemini or OpenAI)
genai.configure(api_key="YOUR_GEMINI_API_KEY")
model = genai.GenerativeModel("gemini-1.5-flash")

def answer_financial_query(db_conn, query: str, user_roles: list[str], top_k: int = 5) -> str:
    # 1. Retrieve Top-K RRF Chunks from Hybrid Search Engine
    query_vector = embed_model.encode(query).tolist()
    retrieved_chunks = execute_hybrid_rrf_search(
        conn=db_conn,
        query_text=query,
        query_vector=query_vector,
        user_roles=user_roles,
        top_k=top_k
    )

    if not retrieved_chunks:
        return "No relevant financial documents found matching your access permissions."

    # 2. Format Context Prompt
    context_blocks = []
    for idx, c in enumerate(retrieved_chunks):
        block = f"[CONTEXT #{idx+1} | TYPE: {c['chunk_type'].upper()} | SECTION: {c['parent_section']}]\n{c['content']}"
        context_blocks.append(block)

    formatted_context = "\n\n---\n\n".join(context_blocks)

    prompt = f"""You are an expert financial analyst. Answer the user question based strictly on the context below.

Context:
{formatted_context}

User Question: {query}
Answer:"""

    # 3. Call LLM for Natural Language Synthesis
    response = model.generate_content(prompt)
    return response.text
```

### Step 3.3: Final Output Delivered to User
> **LLM Response:** *"According to Apple Inc.'s 2024 10-K filing (Section: Item 1. Business > Financial Performance), total revenue for the iPhone segment in fiscal year 2024 was **$201,183 million** (up from $200,583 million in 2023)."*

---

## 5. End-to-End Lifecycle Summary Table

| Stage | Responsibility | Module / Technology | Latency / Metric |
| :--- | :--- | :--- | :--- |
| **1. Upload API** | Validates payload & enqueues job into Redis Queue. | `app/main.py` (FastAPI) | **< 1ms** |
| **2. Background Worker** | Pops job off queue asynchronously. | `app/worker.py` (RQ Worker) | Background Execution |
| **3. Hash Gatekeeper** | SHA-256 check against `document_registry`; skips if unchanged. | `app/worker.py` (hashlib) | ~2ms |
| **4. Structural Chunker** | Isolates tables intact (`table`) and tags section context (`parent_section`). | `app/chunker.py` (Regex) | ~10-50ms |
| **5. Dense Embedding** | Converts text & tables to 384-dim float vectors. | `SentenceTransformers` | ~100-300ms |
| **6. Blue-Green Swap** | Ingests into `rag_index_b` and updates live pointer `rag_index_live`. | PostgreSQL DDL (`app/worker.py`) | **< 1ms** (Atomic SQL) |
| **7. L1 Query Cache** | Serves exact-match queries directly from RAM. | Redis String Cache | **< 2ms** |
| **8. Hybrid RRF Search** | Dense Vector HNSW + GIN Full-Text Search + RRF merging. | PostgreSQL CTEs (`app/hybrid_search.py`) | ~10-30ms |
| **9. LLM Generation** | Synthesizes retrieved context into natural language answer. | Gemini 1.5 / GPT-4 / Llama 3 | ~500-1500ms |
