import { describe, it, expect } from 'vitest';
import { createLogger } from '../../src/utils/logger.js';

describe('createLogger', () => {
  it('should create a logger with default level', () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });

  it('should create a logger with custom level', () => {
    const logger = createLogger('debug');
    expect(logger).toBeDefined();
    expect(logger.level).toBe('debug');
  });

  it('should have console transport', () => {
    const logger = createLogger();
    expect(logger.transports).toHaveLength(1);
  });
});
