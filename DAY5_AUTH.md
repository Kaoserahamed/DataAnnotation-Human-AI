# Day 5 Authentication: Admin/Annotator/Reviewer/Client Roles, OAuth2, JWT, MFA

## Repository
`DataAnnotation-Human-AI` — Human + AI Data Annotation Platform

## Day 5 Task
Authentication - admin/annotator/reviewer/client roles, OAuth2, JWT, MFA | 1 PR

## Implemented
- Added `client` role to `USER_ROLES` (shared) and the `users.role` CHECK constraint (migration).
- Extended `users` table with `refresh_token`, `mfa_enabled`, `mfa_secret`, `oauth_provider`, `oauth_subject`.
- JWT access tokens (existing) plus refresh tokens with rotation (`/auth/refresh`).
- Real logout (`/auth/logout`) revokes the refresh token server-side.
- MFA (TOTP) endpoints: `/auth/mfa/setup`, `/auth/mfa/enable`, `/auth/mfa/verify`, `/auth/mfa/disable`. Login requires MFA token when enabled.
- OAuth2 code-exchange endpoint `/auth/oauth` (provider pluggable; defaults to heuristic subject from headers).
- `verifyToken` updated to accept the `client` role.

## Endpoints added
- POST /api/auth/refresh
- POST /api/auth/logout
- POST /api/auth/mfa/setup
- POST /api/auth/mfa/enable
- POST /api/auth/mfa/verify
- POST /api/auth/mfa/disable
- POST /api/auth/oauth

Day 5 Outcome
Authentication module complete through Day 5. 414 tests pass, typecheck clean.
