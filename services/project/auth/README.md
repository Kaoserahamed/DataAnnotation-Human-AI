# DataAnnotation-Human-AI Authentication Module

## Overview
Authentication system for admin/annotator/reviewer/client roles with OAuth2, JWT, and MFA.

## Files
- `services/project/auth.ts` - Authentication logic
- `services/project/models.ts` - User and role models
- `services/project/middleware.ts` - Auth middleware and RBAC
- `services/project/routes/auth.ts` - Auth API routes
- `services/project/mfa.ts` - Multi-factor authentication

## Features
- Admin, annotator, reviewer, and client account registration/login
- JWT-based session management
- OAuth2 provider integration
- Role-Based Access Control (RBAC)
- Multi-factor authentication (MFA)
- Password hashing with bcrypt
- Session timeout handling

## Tech Stack
- TypeScript/Fastify
- PostgreSQL/PGlite
- JWT
- OAuth2
- bcrypt for password hashing

## Day 5 Outcome
Authentication module implemented. 1 PR created targeting development.