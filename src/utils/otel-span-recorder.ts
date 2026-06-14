import { mkdirSync, appendFileSync } from 'node:fs';
import { createLogger } from './logger.js';

export interface OTelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
  status: { code: number; message?: string };
  events: Array<{
    timeUnixNano: string;
    name: string;
    attributes?: Record<string, string | number | boolean>;
  }>;
}

const LOCAL_TRACES_DIR = '.benchmark-traces-local';

function generateId(length = 16): string {
  const chars = '0123456789abcdef';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export class OTelSpanRecorder {
  private readonly tracesDir: string;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(tracesDir: string = LOCAL_TRACES_DIR, logLevel: string = 'info') {
    this.tracesDir = tracesDir;
    this.logger = createLogger(logLevel);
  }

  private ensureDir(): void {
    try {
      mkdirSync(this.tracesDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  private filePath(): string {
    const date = new Date().toISOString().slice(0, 10);
    return `${this.tracesDir}/spans-${date}.jsonl`;
  }

  record(span: OTelSpan): void {
    this.ensureDir();
    const line = JSON.stringify(span);
    try {
      appendFileSync(this.filePath(), line + '\n');
      this.logger.debug('OTel span recorded', { traceId: span.traceId, name: span.name });
    } catch (err) {
      this.logger.warn('Failed to write OTel span locally', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  startSpan(
    name: string,
    attributes: Record<string, string | number | boolean> = {},
  ): { span: OTelSpan; end: (extraAttributes?: Record<string, string | number | boolean>) => void } {
    const traceId = generateId(32);
    const spanId = generateId(16);
    const startMs = Date.now();
    const startTimeUnixNano = `${startMs}000000`;

    const span: OTelSpan = {
      traceId,
      spanId,
      name,
      kind: 1, // INTERNAL
      startTimeUnixNano,
      endTimeUnixNano: startTimeUnixNano,
      attributes,
      status: { code: 0 }, // UNSET
      events: [],
    };

    const end = (extraAttributes?: Record<string, string | number | boolean>): void => {
      const endMs = Date.now();
      span.endTimeUnixNano = `${endMs}000000`;
      if (extraAttributes) {
        span.attributes = { ...span.attributes, ...extraAttributes };
      }
      this.record(span);
    };

    return { span, end };
  }
}

export const otelSpanRecorder = new OTelSpanRecorder();
