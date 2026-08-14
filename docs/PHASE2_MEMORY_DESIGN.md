# Phase 2 — Memory Architecture

Deliverables §15.1–§15.9. All findings verified against a real PostgreSQL
16.14 instance (same version as the project's Docker image); all tests below
were executed, not asserted.

---

## 1. Existing schema analysis

Ten tables existed: `users`, `agent_memories`, `clients`, `client_notes`,
`documents`, `reminders`, `bookings`, `google_tokens`, `actions_log`, `kv`.

Findings that shaped the design:

- **`clients` was already a generic person entity** —
  `kind = patient|client|student|customer|other`, plus phone/email/summary/tags,
  with `client_notes` for dated notes and `documents.client_id` linking a
  document to a person. Adding a separate `people` table would have created two
  competing person stores and orphaned every existing row.
- **No case/project entity** existed at all.
- **Documents could belong to at most one entity** (`documents.client_id`).
- **No vector implementation.** A comment in `db.js` describes a 768-dim
  embedding column; neither the column nor any code existed.
- **`documents` already has a generated `tsvector` + GIN index** — reusable
  lexical search.
- **pgvector is unavailable** on `postgres:16-alpine` (confirmed:
  `CREATE EXTENSION vector` → "extension must first be installed").

## 2. Entity relationship model

```
users
 ├── clients ......... PEOPLE (widened: relationship, organisation, location, archived)
 │     ├── client_notes
 │     └── case_people ──┐
 ├── cases .............. │ generic: case | project | matter | record
 │     └── case_people ──┘ (many-to-many with people)
 ├── documents
 │     └── document_links (document ↔ person AND/OR case, many-to-many)
 ├── agent_memories ... typed: semantic|episodic|relationship|preference|task
 │                      + subject_type/subject_id, source, confidence,
 │                        valid, invalidated_at, embedding
 ├── events ........... dated: hearings, meetings, deadlines (→ person or case)
 ├── conversations → messages ... episodic source of truth
 └── reminders ........ tasks (existing)
```

## 3. Migration plan

Additive and idempotent — verified by running `db.init()` twice.

- `ALTER TABLE clients ADD COLUMN IF NOT EXISTS` relationship, organisation,
  location, archived.
- `ALTER TABLE agent_memories ADD COLUMN IF NOT EXISTS` kind, subject_type,
  subject_id, source, source_ref, confidence, valid, invalidated_at,
  updated_at, embedding. Existing facts default to
  `kind='semantic', valid=1` and keep working.
- `CREATE TABLE IF NOT EXISTS` cases, case_people, document_links, events,
  conversations, messages.
- **No table is dropped or renamed. No data is migrated destructively.**
  `documents.client_id` is retained and `documentsFor()` unions it with the
  new links, so documents attached before this change still appear.

## 4. Memory architecture

| Layer | Store | Holds |
|---|---|---|
| Structured | PostgreSQL | people, cases, links, events, tasks |
| Semantic | `agent_memories.embedding` (JSONB float array) | facts, summaries |
| Episodic | `conversations` / `messages` | what was actually said |
| Objects | filesystem `documents.path` (S3 in Phase 7) | PDFs, images |

**Why not pgvector:** it is absent from the deployed image, so requiring it
would break deployment. Embeddings are stored as JSONB arrays and ranked by
cosine in Node over a candidate set **first narrowed by structured filters**
(user → subject → validity → importance, capped at 200 rows). The retrieval
API is unchanged if the rows later move to a `vector` column.

**Three-tier retention (§8):** conversation context (in-session, discarded) →
candidate memory (extracted, needs a tool call to persist) → persistent
memory (typed, sourced, correctable). Nothing is saved merely for having
been said.

## 5. Retrieval architecture

`recallAbout(userId, name)` — never vector-only:

```
structured person lookup (exact, then prefix: "Ravi" → "Ravi Kumar")
  → cases for person
  → documents for person UNION documents for their cases
  → events for person UNION events for their cases
  → dated notes
  → valid memories, importance-ranked
```

`search(userId, text)` — structured entity match first; cosine ranking when an
embedding is supplied, lexical overlap otherwise, so recall degrades rather
than dies without an embedding provider.

## 6. Security / tenant isolation

- Every Phase 2 table carries `user_id NOT NULL`; every index leads with it.
- Every service function takes `userId` first and calls `assertUser()`, which
  **throws** on a missing/invalid id — a missing tenant can never become a
  global read.
- `linkDocument()` verifies document ownership before linking.
- `userId` comes from the verified session (`req.user.sub`), never from the
  client body.

Verified by five isolation tests, including "user B cannot link a document
they do not own" and "user B cannot forget user A's memories".

## 7. Implementation

- `src/memory/schema.js` — migration, wired into `db.init()`.
- `src/memory/service.js` — entities, typed memories, correction, hybrid
  retrieval, conversation history.
- `src/tools/builtins.js` — memory exposed as **tools on the existing
  runtime** (§12), not a second agent: `remember_person`, `remember_case`,
  `remember_event`, `remember_fact`, `recall_memory`, `lookup_person`,
  `list_person_documents`, `forget_memory` (high-risk → confirmation).

## 8–9. Test results (executed)

**Phase 1 regression: 19/19 pass** — the runtime and registry are untouched.

**Phase 2 end-to-end vs. real PostgreSQL: 17/17 pass**

| Scenario | Result |
|---|---|
| A — person + case stored structurally, then recalled | PASS |
| B — document linked to a *case* surfaces under the *person* | PASS |
| B — one document belongs to person AND case | PASS |
| C — "hearing on September 3" stored and recalled | PASS |
| D — "forget the hearing date" invalidates it | PASS |
| D — soft delete: row retained with `invalidated_at` for audit | PASS |
| D — restated attribute supersedes, no contradiction | PASS |
| E — 5 isolation tests incl. cross-tenant link and forget | PASS |

## Known gaps (honest)

1. **Embeddings are not yet generated.** The column, storage and cosine
   ranking work; nothing calls the Gemini embedding endpoint yet, so recall
   currently ranks lexically. Wiring it is small and additive.
2. **Automatic extraction is conservative.** Memory is written when the model
   calls a tool; it does not yet mine every turn for candidate facts.
3. **Objects still live on the filesystem.** S3/GCS is Phase 7.
4. **Tool-selection quality is unverified against the live model** — the loop
   is tested with a stubbed model, so which tool Gemini picks for a given
   sentence needs real-device testing.
