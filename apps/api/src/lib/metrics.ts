/**
 * In-process observability counters backing `GET /metrics`.
 *
 * Latency is kept as a bounded ring buffer so memory cannot grow with
 * traffic; percentiles are computed on read. AI pre-labeling counters are
 * recorded by the prelabel service through `recordAiPrediction`.
 */

const LATENCY_WINDOW = 1_000;

interface LatencyState {
  samples: number[];
  cursor: number;
}

export interface MetricsSnapshot {
  requests: { total: number; inFlight: number; errorRate: number };
  latency: { p50: number; p95: number; p99: number };
  ai: { provider: string; predictions: number; failures: number };
}

export class Metrics {
  private requestsTotal = 0;
  private errorsTotal = 0;
  private inFlight = 0;
  private readonly latency: LatencyState = { samples: [], cursor: 0 };
  private aiProvider = 'unknown';
  private aiPredictions = 0;
  private aiFailures = 0;
  private readonly startedAt = Date.now();

  constructor(provider: string) {
    this.aiProvider = provider;
  }

  requestStarted(): void {
    this.inFlight += 1;
    this.requestsTotal += 1;
  }

  requestFinished(durationMs: number, isError: boolean): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (isError) this.errorsTotal += 1;
    if (this.latency.samples.length < LATENCY_WINDOW) {
      this.latency.samples.push(durationMs);
    } else {
      this.latency.samples[this.latency.cursor] = durationMs;
      this.latency.cursor = (this.latency.cursor + 1) % LATENCY_WINDOW;
    }
  }

  recordAiPrediction(failed: boolean): void {
    if (failed) this.aiFailures += 1;
    else this.aiPredictions += 1;
  }

  get uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1_000);
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return Math.round((sorted[Math.max(0, index)] ?? 0) * 100) / 100;
  }

  snapshot(): MetricsSnapshot {
    const sorted = [...this.latency.samples].sort((a, b) => a - b);
    return {
      requests: {
        total: this.requestsTotal,
        inFlight: this.inFlight,
        errorRate:
          this.requestsTotal === 0 ? 0 : Math.round((this.errorsTotal / this.requestsTotal) * 1e4) / 1e4,
      },
      latency: {
        p50: this.percentile(sorted, 50),
        p95: this.percentile(sorted, 95),
        p99: this.percentile(sorted, 99),
      },
      ai: {
        provider: this.aiProvider,
        predictions: this.aiPredictions,
        failures: this.aiFailures,
      },
    };
  }
}
