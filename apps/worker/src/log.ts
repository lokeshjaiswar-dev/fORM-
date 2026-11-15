import { pino, type DestinationStream, type Logger } from 'pino';
import { loggableError } from '@form/db';
import { loggerOptions, serializers, type LoggerConfig } from '@form/observability';

/**
 * The worker's logger: the shared options with the safe `err` serializer (see the API's `createServiceLogger`): a
 * failed query's error carries its bound parameters, which in a job can be a respondent's answers or a file's name.
 */
export function createServiceLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  const options = { ...loggerOptions(config), serializers: { ...serializers, err: loggableError } };
  return destination ? pino(options, destination) : pino(options);
}
