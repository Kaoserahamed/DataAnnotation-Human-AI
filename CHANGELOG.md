# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `@haap/shared` contracts package: task taxonomy covering all eight supported
  annotation modalities (text classification, NER, sentiment, image bounding
  boxes, image segmentation, audio transcription, audio translation, document
  annotation).
- Modality-aware label schemas with a single per-task-type mapping
  (`LABEL_VALUE_SCHEMAS`) and `parseLabelForTaskType` for validating payloads.
- Label comparison primitives: bounding-box IoU, greedy one-to-one geometry and
  entity matching, span similarity, word error rate, and modality-level
  similarity/disagreement.
- Inter-annotator agreement statistics: Cohen's kappa, Fleiss' kappa,
  Krippendorff's alpha, Landis & Koch interpretation bands.
- Active-learning acquisition scoring combining uncertainty, disagreement and
  diversity into a single explainable ranking signal.
- Annotation pipeline state machine encoding the dataset → AI pre-label → human
  verification → correct/incorrect → gold-dataset flow as pure functions.
- Quality-control tooling: seeded QC sampling (random + risk hybrid),
  gold-standard question injection, and gold-check scoring.
- Validation contracts for every request body and query parameter.
- Tooling: TypeScript, ESLint (flat config), Prettier, Vitest with an enforced
  80% coverage floor.

[Unreleased]: https://github.com/Kaoserahamed/Task/compare/v0.1.0...HEAD