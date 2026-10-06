# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2024-01-XX

### Added
- **Annotator Performance Metrics** (`packages/shared/src/metrics.ts`)
  - `calculateAnnotatorMetrics()` - Comprehensive performance tracking (accuracy, velocity, timing)
  - `rankAnnotatorsByQuality()` - Composite quality scoring (70% accuracy, 30% velocity)
  - `detectOutliers()` - IQR-based detection of slow or inaccurate annotators
  - `calculatePairwiseAgreement()` - Identify consistently disagreeing annotator pairs
  - Full test coverage with 27 tests

- **Bulk Processing Utilities** (`packages/shared/src/batch.ts`)
  - `processBatch()` - Concurrent batch processing with progress tracking
  - `chunk()` - Split arrays into fixed-size chunks (max 1000 items per chunk)
  - `validateBulk()` - Bulk validation with detailed error reporting (item + index)
  - `createProgressTracker()` - Real-time progress and ETA calculation
  - `deduplicateBy()` - Remove duplicates by custom key function
  - `retryWithBackoff()` - Exponential backoff retry logic for transient failures
  - Full test coverage with 36 tests

- **Agreement Metrics Enhancement** (`packages/shared/src/agreement.ts`)
  - `percentageAgreement()` - Simple agreement metric without chance correction
  - Complements existing Cohen's kappa, Fleiss' kappa, and Krippendorff's alpha
  - 6 additional tests

### Changed
- Updated `packages/shared/src/index.ts` to export new `metrics` and `batch` modules
- Enhanced README with comprehensive feature documentation
- Expanded API reference with new analytics endpoints

### Technical Details
- All new features implemented as pure functions for maximum testability
- Zero external dependencies added (uses only existing project dependencies)
- Maintains >90% test coverage in shared package (304 tests passing)
- Performance optimized for large-scale annotation operations
- Type-safe with full TypeScript support

### Breaking Changes
None - all changes are additive and backward compatible.

## [0.1.0] - 2024-01-XX

### Added
- Initial release with core annotation platform features
- 8 task types: text classification, sentiment, NER, image bbox, image segmentation, audio transcription, audio translation, document annotation
- AI pre-labeling with confidence-based routing
- Human verification workflow with state machine
- Gold dataset promotion based on agreement thresholds
- Quality control sampling (risk-based + random)
- Active learning with uncertainty, disagreement, and diversity signals
- Inter-annotator agreement metrics (Cohen's kappa, Fleiss' kappa, Krippendorff's alpha)
- RESTful API with Fastify
- PostgreSQL database with migrations
- JWT authentication and bcrypt password hashing
- Pluggable AI provider architecture (OpenAI, heuristic)
- Comprehensive test suite with Vitest
