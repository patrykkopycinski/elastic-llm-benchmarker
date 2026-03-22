import winston from 'winston';

const SERVICE_NAME = 'elastic-llm-benchmarker';
const DEFAULT_APP_LOG_FILE = '/var/log/benchmarker/app.jsonl';

/** ECS-style JSON format for file transport (Elastic Agent / Elasticsearch) */
const jsonFileFormat = winston.format((info) => {
  const { timestamp, level, message, service, ...meta } = info;
  const ts =
    typeof timestamp === 'string' || typeof timestamp === 'number' || timestamp instanceof Date
      ? new Date(timestamp).toISOString()
      : new Date().toISOString();
  return {
    '@timestamp': ts,
    level,
    message,
    'service.name': SERVICE_NAME,
    ...meta,
  };
});

/**
 * Creates a configured Winston logger instance
 */
export function createLogger(level: string = 'info'): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${service ?? SERVICE_NAME}] ${level}: ${message}${metaStr}`;
        }),
      ),
    }),
  ];

  const logFilePath = process.env.APP_LOG_FILE ?? DEFAULT_APP_LOG_FILE;
  const isProduction = process.env.NODE_ENV === 'production';
  const shouldAddFileTransport = isProduction || Boolean(process.env.APP_LOG_FILE);

  if (shouldAddFileTransport) {
    transports.push(
      new winston.transports.File({
        filename: logFilePath,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          jsonFileFormat(),
          winston.format.printf((info) => JSON.stringify(info)),
        ),
      }),
    );
  }

  const logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
    ),
    defaultMeta: { service: SERVICE_NAME },
    transports,
  });

  return logger;
}
