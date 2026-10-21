# Day 3 CI/CD: Build / Test / Deploy Pipeline

## Repository
`DataAnnotation-Human-AI` — Human + AI Data Annotation Platform (TypeScript, Fastify)

## Pipeline Overview
GitHub Actions CI/CD for TypeScript ESM monorepo (npm workspaces).

### Trigger
- Push/Pull Request to `main`
- Manual workflow dispatch

### Stages

#### 1. Format & Lint
- `npm run format:check` (Prettier)
- `npm run lint` (ESLint)

#### 2. Typecheck
- `npm run typecheck` (TypeScript strict mode)

#### 3. Test
- `npm test` (Vitest, 321 tests, 80% coverage threshold)
- `npm run test:coverage` (v8 coverage)
- Unit tests for `packages/shared` (pure domain logic)
- API integration tests (require database - run against Compose stack in CI)

#### 4. Build
- `npm ci` (clean install)
- Docker multi-stage build
- Output: Docker images for API service

#### 5. Security Scan
- `npm audit:prod` (blocks on high/critical)
- `npm audit:all` (informational)
- Secret detection (no `JWT_SECRET` committed)

#### 6. Deploy (on merge to `main`)
- Build and push Docker image
- Deploy with `docker compose up -d`
- Run migrations: `npm run db:migrate`
- Health check: `GET /health`

### Quality Gates
- 80% test coverage threshold enforced
- `npm run verify` (format → lint → typecheck → test:coverage) must pass
- No high/critical vulnerabilities
- TypeScript strict mode clean

### Artifacts
- Docker image
- Test coverage reports (v8)
- TypeScript declaration files
- Audit reports

## Day 3 Outcome
CI/CD pipeline documented. No code changes. 0 PRs. Ready for Day 4 (project restructuring).
<!-- Feature branch commit for PR -->
