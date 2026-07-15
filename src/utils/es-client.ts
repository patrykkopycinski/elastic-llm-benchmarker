import { Client } from '@elastic/elasticsearch';
import type { ElasticsearchConfig } from '../types/config.js';

/** Default ES client timeout — serverless indexing large benchmark docs can exceed 30s. */
export const DEFAULT_ES_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Builds an Elasticsearch client from validated config.
 * Shared by the daemon CLI and the queue API server.
 */
export function createElasticsearchClient(es: ElasticsearchConfig): Client {
  const requestTimeout = es.requestTimeoutMs ?? DEFAULT_ES_REQUEST_TIMEOUT_MS;

  const auth = es.apiKey
    ? { apiKey: es.apiKey }
    : es.username && es.password
      ? { username: es.username, password: es.password }
      : undefined;

  if (es.cloudId) {
    return new Client({
      cloud: { id: es.cloudId },
      ...(auth ? { auth } : {}),
      requestTimeout,
    });
  }

  return new Client({
    node: es.url,
    ...(auth ? { auth } : {}),
    requestTimeout,
  });
}
