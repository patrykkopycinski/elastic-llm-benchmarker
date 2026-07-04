/**
 * Failure classification for benchmarker queue entries.
 *
 * A model that fails to benchmark fails for one of three very different
 * reasons, and the pipeline should react differently to each:
 *
 *  - `transient-infra` — a flaky, self-resolving infrastructure condition
 *    (network/SSH blip, health-check timeout, docker container start race,
 *    disk-full, Buildkite skip/cancel). The model itself is fine; a retry
 *    (after backoff, and after disk-GC in the disk-full case) will likely
 *    pass. RETRIABLE.
 *  - `resource-fit` — the model ran but exhausted a resource under load
 *    (OOM / CUDA out-of-memory at higher concurrency, VRAM overflow). A retry
 *    at lower concurrency may pass. RETRIABLE (bounded).
 *  - `model-arch` — a permanent incompatibility (architecture vLLM can't
 *    serve, no known tool-call parser, tokenizer/quantization mismatch) or a
 *    genuine eval-quality failure (CI eval scores below the gate). Retrying
 *    burns GPU hours to reproduce the same failure. NOT retriable — quarantine.
 *
 * Anything unrecognised is `unknown` and treated as NOT retriable: the
 * conservative default avoids an infinite auto-retry loop on a novel error.
 */
export type FailureCategory =
  | 'transient-infra'
  | 'resource-fit'
  | 'model-arch'
  | 'unknown';

export interface FailureClassification {
  category: FailureCategory;
  /** Whether the daemon may auto-re-enqueue the model (within its retry budget). */
  retriable: boolean;
  /** The pattern that matched, for observability. */
  matched: string;
}

interface Rule {
  category: FailureCategory;
  retriable: boolean;
  pattern: RegExp;
}

// Order matters: the first matching rule wins. Model-arch / eval-quality
// patterns are checked before the broad transient patterns so a specific
// permanent failure is never misread as a retriable blip.
const RULES: Rule[] = [
  // --- model-arch / eval-quality (permanent — quarantine) ---
  { category: 'model-arch', retriable: false, pattern: /architecture[s]?\s+(are|is)?\s*not\s+supported|unsupported\s+(model\s+)?architecture/i },
  { category: 'model-arch', retriable: false, pattern: /no\s+(known\s+)?(tool[-\s]?call|chat)\s+(template|parser)|tool[-\s]?call(ing)?\s+parser\s+not/i },
  { category: 'model-arch', retriable: false, pattern: /tokenizer\s+(class\s+)?.*(not\s+found|does\s+not\s+exist|mismatch)/i },
  { category: 'model-arch', retriable: false, pattern: /quantization\s+.*(not\s+supported|unsupported|incompatible)/i },
  { category: 'model-arch', retriable: false, pattern: /Kibana\s+CI\s+eval\s+failed|Stage\s*2.*(eval|score).*(fail|below)|eval\s+score[s]?\s+below/i },
  { category: 'model-arch', retriable: false, pattern: /failed\s+stage2\s+eligibility|did\s+not\s+pass.*threshold/i },

  // --- resource-fit (retriable at lower concurrency) ---
  { category: 'resource-fit', retriable: true, pattern: /out\s+of\s+memory|CUDA\s+out\s+of\s+memory|OOM|cannot\s+allocate\s+memory|KV\s+cache.*(insufficient|too\s+small)/i },
  { category: 'resource-fit', retriable: true, pattern: /Benchmark\s+failed\s+at\s+concurrency\s+level/i },

  // --- transient-infra (retriable after backoff / GC) ---
  { category: 'transient-infra', retriable: true, pattern: /insufficient\s+disk\s+space|no\s+space\s+left\s+on\s+device|disk\s+(is\s+)?full/i },
  { category: 'transient-infra', retriable: true, pattern: /health\s+check\s+timed\s+out|health\s+check\s+timeout/i },
  { category: 'transient-infra', retriable: true, pattern: /cannot\s+exec\s+in\s+a\s+stopped\s+container|OCI\s+runtime\s+exec\s+failed|container.*(not\s+running|stopped|exited)/i },
  { category: 'transient-infra', retriable: true, pattern: /docker\s+run\s+failed|Cannot\s+connect\s+to\s+the\s+Docker\s+daemon|docker\s+daemon/i },
  { category: 'transient-infra', retriable: true, pattern: /fetch\s+failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket\s+hang\s+up|network\s+error/i },
  { category: 'transient-infra', retriable: true, pattern: /ssh.*(timeout|timed\s+out|connection\s+(refused|reset|closed))|Timed\s+out\s+while\s+waiting\s+for\s+handshake/i },
  { category: 'transient-infra', retriable: true, pattern: /skipped|canceled|cancelled|preempted|pipeline\s+idle/i },
  { category: 'transient-infra', retriable: true, pattern: /shared-VM\s+takeover|taken\s+over\s+externally|Orphaned\s+active\s+entry/i },
  { category: 'transient-infra', retriable: true, pattern: /smoke\s+test\s+failed\s+at\s+tier\s+(health|inference)/i },
];

/**
 * Classify a queue-entry failure message into a category + retriability.
 * Pure and side-effect free. `null`/empty messages classify as `unknown`.
 */
export function classifyFailure(message: string | null | undefined): FailureClassification {
  if (!message || message.trim().length === 0) {
    return { category: 'unknown', retriable: false, matched: '(empty)' };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(message)) {
      return { category: rule.category, retriable: rule.retriable, matched: rule.pattern.source };
    }
  }
  return { category: 'unknown', retriable: false, matched: '(no match)' };
}
