# Day 1 Audit: Repository Baseline

## Repository
`DataAnnotation-Human-AI` — Human + AI Data Annotation Platform (TypeScript, Fastify, PostgreSQL/PGlite)

## Day 1 Task
Repository audit - document existing code, identify technical debt | 0 PRs

## Current State Summary

### Tech Stack
- **Language**: TypeScript (ESM, Node 20)
- **Framework**: Fastify 5
- **Database**: PostgreSQL 16 via `pg`; embedded PGlite for dev/test
- **Package layout**: npm workspaces monorepo (`apps/api` + `packages/shared`)
- **Test runner**: Vitest (321 tests, 80% coverage threshold enforced in CI)
- **AI providers**: Pluggable (`heuristic` built-in, `openai` optional)
- **Container**: Dockerfile (multi-stage), docker-compose.yml for local dev

### Directory Structure (top level)
```
apps/               Applications
  api/              Fastify REST API
packages/           Shared packages
  shared/           Pure domain logic (zero I/O, fully unit-tested)
.github/            CI workflows
docker-compose.yml  Local development stack
.env.example        Environment template
package.json        Root dependencies
tsconfig.base.json  Base TypeScript config
vitest.config.ts    Vitest configuration
```

### Key Files
- `README.md` — comprehensive docs: project type, pipeline (AI pre-labeling → human verification → gold dataset), quick start (zero manual DB setup with PGlite), features (8 annotation modalities, AI-assisted workflow, quality control, active learning, annotator analytics, bulk processing), architecture, API reference, testing, CI/CD, security, workflow state reference, contributing
- `packages/shared/workflow.ts` — annotation state machine + gold-promotion rules
- `packages/shared/quality.ts` — QC sampling and gold injection
- `packages/shared/agreement.ts` — Cohen/Fleiss/Krippendorff/percentage IAA
- `packages/shared/comparison.ts` — per-modality label similarity (IoU, WER)
- `packages/shared/active-learning.ts` — acquisition score from uncertainty/disagreement/diversity
- `packages/shared/metrics.ts` — annotator performance, ranking, outlier detection
- `packages/shared/batch.ts` — bulk processing, retry, progress tracking
- `packages/shared/contracts.ts` — Zod schemas shared between API and clients
- `apps/api/src/routes/` — HTTP handlers (auth, catalog, tasks, quality, analytics)
- `apps/api/src/services/` — orchestration layer
- `apps/api/src/providers/` — prelabel provider interface + implementations

### Technical Debt / Gaps
1. **No Terraform/Helm/Kubernetes** — deployment artifacts limited to Dockerfile and docker-compose; production deployment left to operator
2. **No real-time collaboration** — no WebSocket/SSE for concurrent annotation
3. **No video annotation** — 8 modalities listed but no frame-level video annotation
4. **No LLM annotation / RLHF** — no prompt/response ranking or preference data collection
5. **No dataset versioning** — no version control for datasets (diff, rollback)
6. **No model-in-the-loop training pipeline** — no integration with training frameworks
7. **No SSO/enterprise auth** — JWT only; no SAML/OIDC or SCIM
8. **No audit log** — no immutable audit trail for annotation changes
9. **No GDPR compliance features** — no data export/deletion tools
10. **No mobile app** — web/API only

### What's Needed for Proposed Concept (Data Annotation Platform)
The implementation plan expands into a data annotation platform with active learning workflows, consensus labeling, quality assurance pipeline, dataset versioning, model-in-the-loop annotation, and workforce management. Day 1 establishes the audit baseline; Day 2 begins architecture design for project service, annotation service, quality service, workforce service, and dataset service boundaries.

### Day 1 Outcome
Audit complete. No code changes. 0 PRs. Ready for Day 2 (architecture design).