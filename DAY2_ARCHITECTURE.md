# Day 2 Architecture: Service Boundaries, Database Schema, API Contracts

## Repository
`DataAnnotation-Human-AI` — Human + AI Data Annotation Platform (TypeScript, Fastify, PostgreSQL/PGlite)

## Proposed Concept
Data annotation platform with active learning workflows, consensus labeling, quality assurance pipeline, dataset versioning, model-in-the-loop annotation, and workforce management.

## Service Boundaries
| Service | Responsibility | Technology |
|---------|---------------|------------|
| Project Service | Project creation, instructions, label ontology, dataset association | Fastify, TypeScript, PostgreSQL |
| Annotation Service | Task creation, assignment, label submission, state machine | Fastify, TypeScript, PostgreSQL |
| Quality Service | Consensus labeling, agreement metrics, gold standard, QC sampling | Fastify, TypeScript, PostgreSQL |
| Workforce Service | Annotator onboarding, shift scheduling, capacity, incentives | Fastify, TypeScript, PostgreSQL |
| Dataset Service | Upload, versioning, preprocessing, train/test split, export | Fastify, TypeScript, object storage |
| AI Pre-label Service | Heuristic/OpenAI pre-labeling, confidence scoring | Fastify, pluggable providers |
| Frontend | Annotation interface, task list, quality review, client dashboard | React, TypeScript |

## Database Schema (PostgreSQL)
- `users` — id, email, password_hash, role (admin/annotator/reviewer/client), skills, availability, created_at
- `projects` — id, name, instructions, label_ontology, client_id, status, created_at
- `label_ontology` — id, project_id, labels, attributes, relationships, taxonomies
- `datasets` — id, project_id, name, version, preprocessing_status, train_test_split, created_at
- `dataset_items` — id, dataset_id, content, meta, split, version, created_at
- `annotation_tasks` — id, dataset_item_id, project_id, annotator_id, priority, due_date, status, created_at
- `annotations` — id, task_id, annotator_id, label, confidence, time_spent_ms, created_at
- `consensus_groups` — id, dataset_item_id, project_id, agreement_score, status, created_at
- `gold_standard` — id, dataset_item_id, label, confirmation_count, promoted, created_at
- `quality_scores` — id, annotator_id, accuracy, annotations_per_hour, mean_time_ms, created_at
- `active_learning_queue` — id, dataset_item_id, acquisition_score, uncertainty, disagreement, diversity, created_at
- `dataset_versions` — id, dataset_id, version_number, diff, rollback_point, created_at

## API Contracts
### Projects
- `GET /api/projects` → list
- `POST /api/projects` — {name, description} → {project}
- `GET /api/projects/{id}` → {project, ontology}
- `PATCH /api/projects/{id}` — {status, description} → 204

### Datasets
- `POST /api/projects/{id}/datasets` — {name, taskType, labelSchema} → {dataset}
- `GET /api/datasets/{id}/items` → list (with splits)
- `POST /api/datasets/{id}/items` — {items: [{content, meta, split}]} → {count}
- `POST /api/datasets/{id}/prelabel` — {itemIds?, limit} → {prelabeledCount}
- `GET /api/datasets/{id}/versions` → list
- `POST /api/datasets/{id}/versions/{version}/rollback` → 204

### Tasks (Annotation Queue)
- `GET /api/datasets/{id}/queue` — ?states=&orderBy=acquisition → list
- `POST /api/tasks/{id}/annotate` — {label, confidence?, timeSpentMs?} → {annotation}
- `POST /api/tasks/{id}/review` — {verdict, correctedLabel?, note?} → {review}
- `PATCH /api/tasks/{id}/state` — {state, reason?} → 204
- `GET /api/items/{id}/history` → list

### Quality Control
- `POST /api/datasets/{id}/qc-sample` — {size, seed?, reason?} → {sample}
- `GET /api/datasets/{id}/gold` → list
- `POST /api/datasets/{id}/gold` — {itemIds, force?} → {promoted}
- `GET /api/datasets/{id}/agreement` — ?limit= → {cohenKappa, fleissKappa, krippendorffAlpha}

### Analytics
- `GET /api/projects/{id}/analytics` → {volume, quality, agreement}
- `GET /api/annotators/{id}/metrics` → {accuracy, velocity, ranking}

## Technical Notes
- `packages/shared` contains zero I/O; pure domain logic only
- State machine: `canTransition()` validates all transitions (no illegal jumps)
- Confidence-based routing: ≥0.9 fast-accept; <0.5 auto-escalate to senior reviewer
- Gold promotion: ≥2 independent human confirmations (configurable)
- Active learning: uncertainty (0.4) + disagreement (0.4) + diversity (0.2)
- 8 modalities: text_classification, sentiment, ner, image_bbox, image_segmentation, audio_transcription, audio_translation, document_annotation
- No real-time collaboration, no video annotation, no LLM/RLHF, no dataset versioning yet

## Day 2 Outcome
Architecture design documented. No code changes. 0 PRs. Ready for Day 3 (CI/CD pipeline).