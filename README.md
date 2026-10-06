# Human + AI Data Annotation Platform ⭐⭐⭐⭐⭐

A production-ready annotation system that combines AI pre-labeling with human verification to build high-quality gold-standard datasets.

## 🎯 Overview

Instead of building just another annotation tool, this platform implements an **AI-assisted annotation pipeline** where machines handle the heavy lifting and humans focus on verification and correction — creating a feedback loop that continuously improves data quality.

### The Pipeline

```
        Dataset
           ↓
     AI Pre-labeling
           ↓
   Human Verification
       ↙         ↘
   Correct    Incorrect
      ↓            ↓
   Accepted   Correct Label
       \          /
         ↓
    Gold Dataset
```

## ✨ Key Features

### Core Annotation Capabilities
- **Text Classification** — Single or multi-label categorization
- **Named Entity Recognition (NER)** — Token-level sequence labeling
- **Sentiment Analysis** — Fine-grained emotion detection
- **Image Bounding Boxes** — Object detection with class labels
- **Image Segmentation** — Pixel-level masks and polygons
- **Audio Transcription** — Speech-to-text with timestamps
- **Audio Translation** — Cross-lingual audio content
- **Document Annotation** — Structured extraction from documents

### Advanced Features

#### 🤖 AI-Powered Pre-labeling
- Pluggable AI providers (OpenAI, Anthropic, custom models)
- Confidence-based routing: high-confidence predictions → fast review, low-confidence → expert escalation
- Automatic threshold tuning based on model performance

#### 👥 Human-in-the-Loop
- Smart task assignment based on annotator skill and workload
- Single-click acceptance for high-confidence AI labels
- Correction mode for disagreements with AI predictions
- Escalation workflow for ambiguous or difficult cases

#### 🏆 Quality Control
- **Inter-annotator Agreement** — Cohen's kappa, Fleiss' kappa, Krippendorff's alpha, percentage agreement
- **Gold Standard Questions** — Injected check questions with known answers
- **QC Sampling** — Deterministic risk-based + random sampling for audit
- **Annotator Performance Analytics** — Accuracy, velocity, quality scoring, outlier detection
- **Agreement-based Promotion** — Items require multiple independent confirmations before gold status
- **Pairwise Agreement Tracking** — Identify consistently disagreeing annotator pairs

#### 🎓 Active Learning
- Uncertainty sampling based on model confidence
- Diversity sampling to cover the feature space
- Disagreement-based selection (high inter-annotator variance)
- Query-by-committee for ensemble models

#### 📊 Analytics & Insights
- Real-time project progress dashboards
- Per-annotator performance tracking
- Label distribution and class balance analysis
- Time-to-complete metrics
- Quality trend visualization

## 🏗️ Architecture

### Monorepo Structure
```
human-ai-annotation-platform/
├── packages/
│   └── shared/           # Core business logic (framework-agnostic)
│       ├── workflow.ts   # State machine for annotation pipeline
│       ├── quality.ts    # QC sampling & gold injection
│       ├── agreement.ts  # Inter-annotator agreement metrics
│       ├── comparison.ts # Modality-aware label similarity
│       ├── metrics.ts    # Annotator performance tracking
│       ├── batch.ts      # Bulk processing utilities
│       └── contracts.ts  # Zod validation schemas
└── apps/
    └── api/              # Fastify REST API
        ├── routes/       # HTTP endpoints
        ├── services/     # Business logic orchestration
        ├── providers/    # AI model integrations
        └── db/           # PostgreSQL + migrations
```

### Design Principles

#### Pure Functions Over Data
The entire annotation workflow is encoded as **pure functions** in `packages/shared`. No database, HTTP, or AI calls are embedded in the core logic — only data transformation. This means:
- ✅ The entire pipeline is unit-testable in milliseconds
- ✅ State transitions are deterministic and auditable
- ✅ The same seed always produces the same QC sample (reproducibility)
- ✅ Business rules are never hidden in SQL or API handlers

```typescript
// Example: the core verification logic is a pure function
export function decideVerification(input: VerifyInput): VerificationOutcome {
  const { taskType, aiLabel, humanLabel, priorHumanConfirmations } = input;
  
  const agrees = labelSimilarity(taskType, aiLabel, humanLabel) >= 1;
  
  if (agrees) {
    return {
      kind: 'accepted',
      verdict: 'correct',
      nextState: 'accepted',
      promoteToGold: qualifiesForGold(priorHumanConfirmations + 1),
    };
  }
  
  return {
    kind: 'corrected',
    verdict: 'corrected',
    nextState: 'needs_correct',
    promoteToGold: false,
  };
}
```

The API layer (`apps/api/services`) simply loads data, calls these functions, and persists results.

#### Type-Safe Contracts
All API requests and responses are validated with [Zod](https://zod.dev). Schemas live in `packages/shared/contracts.ts` so frontend and backend share the exact same type definitions.

#### Pluggable AI Providers
The platform abstracts AI inference behind a `PrelabelProvider` interface. Built-in providers:
- **OpenAI** (GPT-4, GPT-3.5)
- **Heuristic** (baseline rules for testing)

Add your own by implementing:
```typescript
interface PrelabelProvider {
  name: string;
  prelabel(item: CatalogItem, taskType: TaskType): Promise<PrelabelResult>;
}
```

## 🚀 Getting Started

### Prerequisites
- **Node.js** ≥ 20.11.0
- **PostgreSQL** ≥ 14
- **npm** (comes with Node.js)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd HumanAndAIDataAnnotation

# Install dependencies
npm install

# Set up environment variables
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env with your database URL and API keys

# Run database migrations
npm run db:migrate

# Seed sample data (optional)
npm run db:seed
```

### Development

```bash
# Run the API server (localhost:3000)
npm run dev

# Run tests with coverage
npm run test:coverage

# Type check
npm run typecheck

# Lint and format
npm run lint
npm run format

# Full verification (CI checks)
npm run verify
```

### Configuration

Key environment variables (`apps/api/.env`):

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/annotation_db

# Server
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173

# AI Provider
AI_PROVIDER=openai  # or 'heuristic'
OPENAI_API_KEY=sk-...

# Security
JWT_SECRET=your-secret-key-min-32-chars
BCRYPT_ROUNDS=10
```

## 📖 API Reference

### Authentication
```bash
POST /api/auth/register
POST /api/auth/login
POST /api/auth/me
```

### Catalog Management
```bash
GET    /api/catalog/projects
POST   /api/catalog/projects
GET    /api/catalog/projects/:id/items
POST   /api/catalog/projects/:id/items
POST   /api/catalog/projects/:id/items/bulk
```

### Annotation Tasks
```bash
GET    /api/tasks/:projectId/next         # Get next task to annotate
POST   /api/tasks/:taskId/accept          # Accept AI label
POST   /api/tasks/:taskId/correct         # Submit human correction
POST   /api/tasks/:taskId/escalate        # Escalate to expert
GET    /api/tasks/:taskId/history         # View annotation history
```

### Quality Control
```bash
POST   /api/quality/qc-sample             # Generate QC sample
GET    /api/quality/gold-questions        # List gold standard items
POST   /api/quality/gold-questions        # Create gold item
POST   /api/quality/evaluate-annotator   # Score against gold checks
```

### Analytics
```bash
GET    /api/analytics/project/:id         # Project-level metrics
GET    /api/analytics/annotator/:id      # Annotator performance (accuracy, velocity, quality score)
GET    /api/analytics/annotator/rankings # Ranked list of annotators by quality
GET    /api/analytics/annotator/outliers # Detect slow/inaccurate annotators
GET    /api/analytics/agreement          # Inter-annotator agreement (kappa, alpha, %)
GET    /api/analytics/agreement/pairwise # Pairwise agreement rates between annotators
GET    /api/analytics/labels             # Label distribution and class balance
```

### System
```bash
GET    /health                            # Health check
GET    /metrics                           # Prometheus-style metrics
GET    /version                           # Version info
```

## 🧪 Testing

### Unit Tests
```bash
npm run test              # Run once
npm run test:watch        # Watch mode
npm run test:coverage     # With coverage report
```

### Test Coverage Goals
- **Shared Package**: >90% (pure functions) ✅ **Achieved: 304 tests passing**
- **API Services**: >80%
- **API Routes**: >70%

### Current Test Coverage
- **agreement.ts**: Cohen's kappa, Fleiss' kappa, Krippendorff's alpha, percentage agreement (34 tests)
- **active-learning.ts**: Uncertainty, disagreement, diversity scoring (24 tests)
- **workflow.ts**: State transitions, verification logic, gold promotion (29 tests)
- **quality.ts**: QC sampling, gold injection planning (22 tests)
- **comparison.ts**: Label similarity across all 8 task types (33 tests)
- **metrics.ts**: Annotator performance, quality ranking, outlier detection (27 tests) ✨ **NEW**
- **batch.ts**: Chunking, concurrent processing, validation, retry logic (36 tests) ✨ **NEW**
- **contracts.ts**: Zod schema validation (54 tests)
- **labels.ts**: Label parsing and validation (20 tests)

### Example Test Structure
```typescript
// packages/shared/test/workflow.test.ts
describe('decideAfterPrelabel', () => {
  it('escalates low-confidence predictions', () => {
    const decision = decideAfterPrelabel(0.3);
    expect(decision.nextState).toBe('escalated');
    expect(decision.requiresEscalation).toBe(true);
  });

  it('allows fast-accept for high-confidence predictions', () => {
    const decision = decideAfterPrelabel(0.95);
    expect(decision.nextState).toBe('pending_review');
    expect(decision.canFastAccept).toBe(true);
  });
});
```

## 🔐 Security

- **Password Hashing**: bcrypt with configurable rounds
- **JWT Authentication**: Stateless session tokens
- **Input Validation**: Zod schemas on all endpoints
- **SQL Injection Protection**: Parameterized queries (Postgres.js)
- **Rate Limiting**: Helmet middleware with sensible defaults
- **CORS**: Configurable origin whitelist

## 🎯 Quality Metrics

### Inter-Annotator Agreement
```typescript
// Cohen's Kappa for binary tasks
const kappa = cohensKappa(table);

// Fleiss' Kappa for multiple annotators
const fleiss = fleissKappa(ratings, categories);

// Krippendorff's Alpha (handles missing data)
const alpha = krippendorffAlpha(ratingsMatrix, categories);

// Percentage agreement (exact match)
const pct = percentageAgreement(table);
```

### Annotator Performance Tracking
```typescript
import { calculateAnnotatorMetrics, rankAnnotatorsByQuality } from '@haap/shared';

// Calculate comprehensive metrics for an annotator
const metrics = calculateAnnotatorMetrics(annotationRecords);
// Returns: accuracy, velocity (annotations/hour), mean/median time, gold check count

// Rank all annotators by composite quality score
const ranked = rankAnnotatorsByQuality(allMetrics);
// Weights: 70% accuracy, 30% velocity

// Detect outliers (unusually slow or inaccurate)
const outliers = detectOutliers(allMetrics);
// Returns: { lowAccuracy: string[], lowVelocity: string[] }

// Calculate pairwise agreement rates
const pairs = calculatePairwiseAgreement(records, labelEquals);
// Identifies consistently disagreeing pairs for calibration
```

### Bulk Processing
```typescript
import { processBatch, chunk, validateBulk } from '@haap/shared';

// Process large datasets in controlled batches
const result = await processBatch(items, async (item) => {
  return await annotateItem(item);
}, {
  batchSize: 100,
  concurrency: 5,
  onProgress: (completed, total) => {
    console.log(`Progress: ${completed}/${total}`);
  }
});

// Split into chunks for manual processing
const batches = chunk(items, 50);

// Validate bulk imports with detailed error reporting
const { valid, invalid } = validateBulk(items, validator);
// invalid includes: item, error message, and original index
```

### Gold Dataset Promotion
Items are promoted to gold status when they receive **2+ independent human confirmations** (configurable via `PIPELINE_THRESHOLDS.goldAgreementRequired`).

### QC Sampling Strategy
- **30% random** — ensures coverage of easy items, prevents gaming
- **70% risk-based** — focuses on high-uncertainty predictions
- **Deterministic** — same seed + candidates = same sample (auditable)

## 📊 Workflow States

```
pending_prelabel  →  pending_review  →  accepted ✓
                         ↓
                    needs_correct  →  pending_review
                         ↓
                    escalated  →  in_review  →  accepted
```

### State Transitions
| From State         | Allowed Transitions                               |
|--------------------|---------------------------------------------------|
| `pending_prelabel` | `pending_review`, `pending_human`                |
| `pending_review`   | `accepted`, `needs_correct`, `escalated`         |
| `needs_correct`    | `pending_review`, `accepted`, `escalated`        |
| `escalated`        | `pending_review`, `in_review`, `accepted`        |
| `accepted`         | Terminal (can be escalated if needed)            |

## 🛠️ Technology Stack

### Backend
- **Fastify** — Fast, low-overhead web framework
- **PostgreSQL** — Relational database with JSONB support
- **Postgres.js** — Type-safe SQL client
- **Zod** — Schema validation and TypeScript inference
- **bcrypt** — Password hashing
- **jsonwebtoken** — JWT authentication

### Testing & Quality
- **Vitest** — Fast unit test runner
- **@vitest/coverage-v8** — Coverage reporting
- **ESLint** — Linting with TypeScript support
- **Prettier** — Code formatting
- **TypeScript** — Static type checking

### AI Integration
- **OpenAI API** — GPT-4/3.5 for text tasks
- Pluggable architecture for custom models

## 🤝 Contributing

### Development Workflow
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run verification: `npm run verify`
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Code Style
- Follow existing patterns in the codebase
- Write tests for new features
- Update documentation as needed
- Use conventional commit messages

### Adding New Task Types
1. Add the type to `TASK_TYPES` in `packages/shared/src/task-types.ts`
2. Add label schema to `packages/shared/src/labels.ts`
3. Implement similarity in `packages/shared/src/comparison.ts`
4. Add provider support in `apps/api/src/providers/`
5. Write tests!

## 📚 Documentation

- **[API Documentation](docs/api.md)** — Full endpoint reference
- **[Architecture Guide](docs/architecture.md)** — System design deep-dive
- **[Quality Control](docs/quality-control.md)** — QC strategies and metrics
- **[Active Learning](docs/active-learning.md)** — Sample selection strategies

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

Inspired by best practices from:
- **Label Studio** — Flexible annotation framework
- **Prodigy** — Active learning for NLP
- **Scale AI** — Human-in-the-loop at scale
- **Amazon SageMaker Ground Truth** — Managed annotation workflows

## 📞 Support

- **Issues**: [GitHub Issues](../../issues)
- **Discussions**: [GitHub Discussions](../../discussions)
- **Email**: [support@example.com](mailto:support@example.com)

---

Built with ❤️ for the data science community. Star ⭐ this repo if you find it useful!
