import { pino, type DestinationStream, type Logger } from 'pino';
import { loggableError } from '@form/db';
import { loggerOptions, serializers, type LoggerConfig } from '@form/observability';

/**
 * The service logger: the shared options (redaction, request serializers) with one change, the `err` serializer.
 * A failed query's error carries every bound parameter in its message and its `params`, which for a submission are
 * the respondent's answers; `loggableError` logs the SQLSTATE, the constraint and the SQL text and nothing the
 * respondent typed. Set here, once, so no call site has to remember to scrub.
 */
export function createServiceLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  const options = { ...loggerOptions(config), serializers: { ...serializers, err: loggableError } };
  return destination ? pino(options, destination) : pino(options);
}
