-- DB-NEW-001 launch blocker: pgvector HNSW index for memory_embeddings.
--
-- Without this index, every semantic memory search (`searchMemory()`) does a
-- full table scan over memory_embeddings.embedding (vector(1536)). At scale
-- that's O(n) per query — fine at 1k rows, unacceptable at 1M.
--
-- HNSW gives sub-linear nearest-neighbour lookup with high recall (95%+ at
-- the default ef_search=40). vector_cosine_ops matches the operator the app
-- uses (`embedding <=> query` is cosine distance).
--
-- We use CONCURRENTLY so the migration does NOT take an ACCESS EXCLUSIVE
-- lock on memory_embeddings. The trade-off is the migration takes longer
-- to run (because Postgres builds the index in two passes without blocking
-- writes). On a fresh install with an empty table this is effectively
-- instant.
--
-- IF NOT EXISTS keeps the migration idempotent — re-running on a database
-- that already has the index does nothing instead of erroring.
--
-- Notes:
--   * `prisma migrate` runs each migration in a single transaction by
--     default, but CREATE INDEX CONCURRENTLY is incompatible with running
--     inside a transaction. Prisma's docs explicitly call this case out
--     and run the statement outside the transaction wrapper as long as the
--     migration contains no other DDL.
--   * No corresponding change to schema.prisma — Prisma doesn't model
--     index `USING` clauses for unsupported types, so the index lives in
--     migrations only. `prisma migrate diff` will not report drift.

CREATE INDEX CONCURRENTLY IF NOT EXISTS memory_embeddings_embedding_hnsw_idx
  ON memory_embeddings
  USING hnsw (embedding vector_cosine_ops);
