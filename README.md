# Human + AI Data Annotation Platform

A production-ready annotation system that combines AI pre-labeling with human
verification to build high-quality, gold-standard datasets — no manual setup
required for local development.

[![CI](https://github.com/Kaoserahamed/DataAnnotation-Human-AI_v1/actions/workflows/ci.yml/badge.svg)](https://github.com/Kaoserahamed/DataAnnotation-Human-AI_v1/actions/workflows/ci.yml)

---

## Project Type

This is a **backend application platform**, not infrastructure-as-code.

| Signal | Value |
|--------|-------|
| Language | TypeScript (ESM, Node 20) |
| Framework | Fastify 5 |
| Database | PostgreSQL 16 via `pg`; embedded PGlite for dev/test |
| Package layout | npm workspaces monorepo (`apps/api` + `packages/shared`) |
| Test runner | Vitest (321 tests, 80% coverage threshold enforced in CI) |
| AI providers | Pluggable (`heuristic` built-in, `openai` optional) |

There is no Terraform, Helm, Kubernetes, Pulumi, or Ansible in this repository.
All deployment artifacts are a `Dockerfile` (multi-stage) and a
`docker-compose.yml` for local development; production deployment is
intentionally left to the operator's chosen platform.

---

## The Pipeline

```
        Dataset
           ↓
     AI Pre-labeling
     (confidence score)
           ↓
   Human Verification
       ↙         ↘
   Correct     Incorrect
      ↓              ↓
   Accepted    Corrected Label
       \            /
         ↓
    Gold Dataset
```

---

## Quick Start (zero manual database setup)

The test suite and development server both use an embedded
[PGlite](https://pglite.dev/) database that requires no external PostgreSQL
instance. A fresh clone is runnable in three commands:

```bash
# 1 – Install
npm install

# 2 – Run all tests (321 tests, no database required)
npm test

# 3 – Start the dev server (embedded DB, heuristic AI provider)
npm run dev
# API is available at http://localhost:4000
# GET http://localhost:4000/health  →  { "status": "ok", … }
```

> **Node.js ≥ 20.11.0** is required (exact version locked in
> `package.json` `engines` field and used by CI).

### Full verification (what CI runs)

```bash
npm run verify
# runs: format:check → lint → typecheck → test:coverage (80% threshold)
```

---

## Getting Started with PostgreSQL (production-like)

For a setup that mirrors production (persistent data, external PostgreSQL):

```bash
# 1 – Copy and fill in the env template
cp apps/api/.env.example apps/api/.env
# Set DB_CLIENT=postgres, DATABASE_URL, and JWT_SECRET

# 2 – Start PostgreSQL with Docker Compose
docker compose up -d
# waits until postgres:16 is healthy before returning

# 3 – Install dependencies and run migrations
npm install
npm run db:migrate

# 4 – (Optional) seed demo data — all 8 modalities
npm run db:seed
# Prints: "sign in with admin@demo.local / <generated-password>"

# 5 – Start the dev server
npm run dev
```

### Env variables

All accepted variables are documented with defaults in
[`apps/api/.env.example`](apps/api/.env.example). The only **required**
variable in production is `JWT_SECRET` (≥ 32 chars):

```bash
# Generate a secret:
openssl rand -hex 32
```

---

## Features

### Annotation task types (all 8 modalities)

| Type | Payload | Comparison metric |
|------|---------|-------------------|
| `text_classification` | `{ label }` | Exact match |
| `sentiment` | `{ label }` | Exact match |
| `ner` | `[{ text, start, end, label }]` | Levenshtein span similarity |
| `image_bbox` | `[{ x, y, width, height, label }]` | IoU ≥ 0.5 |
| `image_segmentation` | `[{ points, label }]` | Centroid distance |
| `audio_transcription` | `[{ startMs, endMs, text }]` | 1 − WER |
| `audio_translation` | `{ label }` | Exact match |
| `document_annotation` | `{ label }` | Exact match |

### AI-assisted workflow

- **Confidence-based routing**: score ≥ 0.9 → fast-accept eligible; score < 0.5 → auto-escalated to senior reviewer
- **Pluggable providers**: `heuristic` (deterministic, zero API key) and `openai` (GPT-4o-mini by default)
- **State machine**: every transition is validated by `canTransition()` — no illegal state jumps possible

### Quality control

- **Inter-annotator agreement**: Cohen's κ, Fleiss' κ, Krippendorff's α, percentage agreement
- **Gold standard injection**: configurable fraction of tasks are known-answer check questions
- **QC sampling**: 30% random + 70% risk-based; deterministic per seed (auditable)
- **Gold promotion**: requires ≥ 2 independent human confirmations (configurable)

### Active learning

- **Uncertainty** (1 − max probability), **disagreement** (1 − mean pairwise similarity), **diversity** (1 − Jaccard redundancy) combined into a single acquisition score (weights: 0.4 / 0.4 / 0.2)

### Annotator performance analytics

```typescript
import { calculateAnnotatorMetrics, rankAnnotatorsByQuality, detectOutliers } from '@haap/shared';

const metrics = calculateAnnotatorMetrics(records);
// → { accuracy, annotationsPerHour, meanTimeMs, medianTimeMs, goldCheckCount }

const ranked = rankAnnotatorsByQuality(allMetrics);
// → composite score: 70% accuracy + 30% velocity, sorted descending

const { lowAccuracy, lowVelocity } = detectOutliers(allMetrics);
// → IQR-based flagging; returns annotator IDs below Q1 − 1.5 × IQR
```

### Bulk processing

```typescript
import { processBatch, validateBulk, retryWithBackoff } from '@haap/shared';

const result = await processBatch(items, processor, {
  batchSize: 100, concurrency: 5,
  onProgress: (done, total) => console.log(`${done}/${total}`),
});
// result.succeeded / result.failed / result.durationMs

const { valid, invalid } = validateBulk(rawItems, validator);
// invalid[i] → { item, error: string, index: number }

const value = await retryWithBackoff(fetchPrediction, {
  maxRetries: 3, initialDelayMs: 100, backoffFactor: 2,
});
```

---

## Architecture

```
human-ai-annotation-platform/
├── packages/shared/          # Pure domain logic — zero I/O, fully unit-tested
│   ├── workflow.ts           # Annotation state machine + gold-promotion rules
│   ├── quality.ts            # QC sampling (risk + random) and gold injection
│   ├── agreement.ts          # Cohen/Fleiss/Krippendorff/percentage IAA
│   ├── comparison.ts         # Per-modality label similarity (IoU, WER, …)
│   ├── active-learning.ts    # Acquisition score from uncertainty/disagreement/diversity
│   ├── metrics.ts            # Annotator performance, ranking, outlier detection
│   ├── batch.ts              # Bulk processing, retry, progress tracking
│   └── contracts.ts          # Zod schemas shared between API and future clients
└── apps/api/                 # Fastify REST API
    ├── src/routes/           # HTTP handlers (auth, catalog, tasks, quality, analytics)
    ├── src/services/         # Orchestration: load → domain fn → persist
    ├── src/providers/        # PrelabelProvider interface + heuristic + openai impls
    ├── src/lib/              # auth (scrypt+JWT), errors, ids, metrics, http helpers
    └── src/db/               # PostgreSQL via pg + PGlite, migrations, seed CLI
```

**Design rule**: `packages/shared` contains zero I/O. Every business
decision (state transition, confidence threshold, gold promotion, QC sample
selection) is a pure function. The services layer loads data, calls those
functions, and persists results. This keeps the entire domain testable in
milliseconds without any database or network.

---

## API Reference

### Authentication

```
POST /api/auth/register   { email, name, password, role? }
POST /api/auth/login      { email, password } → { token }
GET  /api/auth/me         Bearer → { user }
```

### Projects & Datasets

```
GET  /api/projects
POST /api/projects                       { name, description }
GET  /api/projects/:id
PATCH /api/projects/:id                  { status?, description? }

POST /api/projects/:id/datasets          { name, taskType, labelSchema }
GET  /api/datasets/:id/items
POST /api/datasets/:id/items             { items: [{ content, meta?, split? }] }
POST /api/datasets/:id/prelabel          { itemIds?, limit }
```

### Tasks (annotation queue)

```
GET  /api/datasets/:id/queue             ?states=&orderBy=acquisition
POST /api/tasks/:id/annotate             { label, annotatorConfidence?, timeSpentMs? }
POST /api/tasks/:id/review               { verdict, correctedLabel?, note? }
PATCH /api/tasks/:id/state               { state, reason? }
GET  /api/items/:id/history
```

### Quality Control

```
POST /api/datasets/:id/qc-sample         { size, seed?, reason? }
GET  /api/datasets/:id/gold
POST /api/datasets/:id/gold              { itemIds, force? }
GET  /api/datasets/:id/agreement         ?limit=
```

### Analytics

```
GET  /api/projects/:id/analytics
GET  /api/annotators/:id/metrics
```

### System

```
GET  /health
GET  /ready
GET  /metrics
GET  /version
```

---

## Testing

```bash
npm test                  # run once, all workspaces
npm run test:watch        # watch mode
npm run test:coverage     # with v8 coverage (80% threshold enforced)
```

### Current coverage (321 tests, 10 suites)

| File | Tests | Notes |
|------|-------|-------|
| `shared/agreement.ts` | 48 | Cohen/Fleiss/Krippendorff/percentage + edge cases |
| `shared/contracts.ts` | 54 | Zod schema validation for all request/response shapes |
| `shared/workflow.ts` | 42 | State machine, thresholds, gold promotion paths |
| `shared/comparison.ts` | 45 | IoU, WER, span similarity, all 8 modalities |
| `shared/batch.ts` | 36 | Chunking, concurrency, retry, progress, dedup |
| `shared/quality.ts` | 22 | QC sampling, gold injection planning |
| `shared/metrics.ts` | 27 | Annotator perf, ranking, outlier detection |
| `shared/active-learning.ts` | 24 | Uncertainty, disagreement, diversity, scoring |
| `shared/labels.ts` | 20 | Label parsing, schema validation |
| `shared/contracts.ts` + index | 3 | Public surface smoke test |
| `api/lib.test.ts` | 42 | AppError, errors factory, Metrics, newId, normalizeQuery |
| `api/providers.test.ts` | 13 | Heuristic + OpenAI provider contract |
| `api/security.test.ts` | 15 | Config guard-rails, scrypt, JWT, role enforcement |

API integration tests (`quality.test.ts`, `workflow.e2e.test.ts`) require a
running database and are skipped when no DB is configured — they are designed
to run in CI against the Compose stack.

---

## CI / CD

Every push and pull request to `main` runs two GitHub Actions jobs:

| Job | Steps |
|-----|-------|
| **Lint · Typecheck · Test** | `npm ci` → `format:check` → `lint` → `typecheck` → `test:coverage` (80% threshold) |
| **Dependency Audit** | `audit:prod` (blocks on high/critical) + `audit:all` (informational) |

Coverage artifacts are uploaded for 7 days.
[Dependabot](/.github/dependabot.yml) opens weekly PRs for npm packages
(root, api, shared) and GitHub Actions.

---

## Security

- Passwords hashed with **scrypt** (N=16384, r=8, p=1) + random salt, constant-time compare
- **HS256 JWTs** via `jose`; claims embedded so authorization needs no DB lookup per request
- All inputs validated by **Zod** at the route boundary before reaching services
- Postgres queries use **parameterized statements** (no string interpolation)
- `JWT_SECRET` is required in production and must differ from the dev placeholder
- Demo seed password read from `SEED_PASSWORD` env var; auto-generated (random hex) when unset
- Test passwords generated with `randomBytes(16).toString('hex')` — no literals in source

---

## Workflow State Reference

```
pending_prelabel ──→ pending_review ──→ accepted
        │                  │                │
        ↓                  ↓                ↓ (escalate if QC fails)
  pending_human      needs_correct      escalated
        │                  │                │
        └──────────────────┴───────→ in_review
```

| State | Allowed next states |
|-------|---------------------|
| `pending_prelabel` | `pending_review`, `pending_human` |
| `pending_review` | `accepted`, `needs_correct`, `escalated`, `pending_human` |
| `pending_human` | `pending_review`, `accepted`, `escalated` |
| `in_review` | `accepted`, `needs_correct`, `escalated` |
| `needs_correct` | `pending_review`, `accepted`, `escalated` |
| `escalated` | `pending_review`, `in_review`, `accepted` |
| `accepted` | `escalated` |
| `rejected` | *(terminal)* |

---

## Contributing

```bash
# 1 Fork → clone → install
npm install

# 2 Make your change + write the tests that prove it
# 3 Verify everything passes
npm run verify

# 4 Commit with a conventional message
git commit -m "feat(shared/workflow): add batch-escalation helper"

# 5 Open a PR against main
```

Commit message convention: `<type>(<scope>): <summary>`.  
Types: `feat`, `fix`, `test`, `refactor`, `docs`, `ci`, `chore`.

### Adding a new task type

1. `packages/shared/src/task-types.ts` — add to `TASK_TYPES`
2. `packages/shared/src/labels.ts` — add Zod schema + export type
3. `packages/shared/src/comparison.ts` — add `labelSimilarity` case
4. `apps/api/src/providers/heuristic.ts` — add prelabel rule
5. `packages/shared/test/comparison.test.ts` — add modality tests
6. Submit as separate commits for (3) + tests and (4) + tests

---

## License

MIT — see [LICENSE](LICENSE).
