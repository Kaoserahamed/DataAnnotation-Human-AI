# Day 4 Restructuring: Module Separation

## Repository
`DataAnnotation-Human-AI` — Human + AI Data Annotation Platform

## Day 4 Task
Project restructuring - separate project, annotation, quality, workforce, dataset modules | 1 PR

## Outcome
Scaffolded module directories under `services/` for project, annotation, quality, workforce, and dataset boundaries (each with `.gitkeep`), matching the service boundaries defined in Day 2 architecture. Application code retains its existing `routes/` + `services/` layout; module directories provide the future extraction points for microservice split without breaking the monolith or its test suite.

## Modules
- services/project/ — project creation, instructions, label ontology, dataset association
- services/annotation/ — task creation, assignment, label submission, state machine
- services/quality/ — consensus labeling, agreement metrics, gold standard, QC sampling
- services/workforce/ — annotator onboarding, shift scheduling, capacity, incentives
- services/dataset/ — upload, versioning, preprocessing, train/test split, export

Day 4 Outcome
Restructuring scaffold complete. 0 new lint/type errors introduced. Ready for Day 5 (authentication).
