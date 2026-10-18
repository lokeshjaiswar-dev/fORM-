import { register } from 'node:module';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { scrubQuery, scrubUrl } from './scrub.ts';

/** `url.path` is listed because some instrumentations (@fastify/otel) put the raw request target there. */
const URL_ATTRIBUTES = ['http.url', 'http.target', 'url.full', 'url.path', 'http.request.header.referer'];
const QUERY_ATTRIBUTES = ['url.query'];

function scrubSpan(span: Span): void {
  for (const key of URL_ATTRIBUTES) {
    const v = span.attributes[key];
    if (typeof v === 'string') span.setAttribute(key, scrubUrl(v));
  }
  for (const key of QUERY_ATTRIBUTES) {
    const v = span.attributes[key];
    if (typeof v === 'string') span.setAttribute(key, scrubQuery(v));
  }
}

/** Scrubs URL attributes while the span is still writable, then hands it on (architecture §3.2: no prefill values in traces). */
export class ScrubbingSpanProcessor implements SpanProcessor {
  readonly #inner: SpanProcessor;

  constructor(inner: SpanProcessor) {
    this.#inner = inner;
  }

  onStart(span: Span, parentContext: Context): void {
    scrubSpan(span);
    this.#inner.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    scrubSpan(span);
  }

  onEnd(span: ReadableSpan): void {
    this.#inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.#inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.#inner.shutdown();
  }
}

export interface TelemetryConfig {
  /** OTLP/HTTP base URL, e.g. `http://otel-collector:4318`. Telemetry stays off when unset. */
  endpoint?: string | undefined;
  serviceName: string;
  serviceVersion?: string;
  /** Head sampling ratio for root spans (architecture §7.7: 10%). */
  sampleRatio: number;
}

export interface Telemetry {
  shutdown(): Promise<void>;
}

/**
 * Starts tracing only when an OTLP endpoint is configured; on-prem sends nothing anywhere by default.
 * Call it before importing fastify or pg: the ESM loader hook only patches modules loaded afterwards.
 */
export async function startTelemetry(config: TelemetryConfig): Promise<Telemetry | undefined> {
  if (!config.endpoint) return undefined;

  const { createAddHookMessageChannel } = await import('import-in-the-middle');
  const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
  register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);

  const [{ NodeTracerProvider }, base, { OTLPTraceExporter }, { resourceFromAttributes }, { registerInstrumentations }, http, pg, undici, fastify] =
    await Promise.all([
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/instrumentation'),
      import('@opentelemetry/instrumentation-http'),
      import('@opentelemetry/instrumentation-pg'),
      import('@opentelemetry/instrumentation-undici'),
      import('@fastify/otel'),
    ]);

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': config.serviceName,
      ...(config.serviceVersion ? { 'service.version': config.serviceVersion } : {}),
    }),
    sampler: new base.ParentBasedSampler({ root: new base.TraceIdRatioBasedSampler(config.sampleRatio) }),
    spanProcessors: [
      new ScrubbingSpanProcessor(new base.BatchSpanProcessor(new OTLPTraceExporter({ url: `${config.endpoint.replace(/\/+$/, '')}/v1/traces` }))),
    ],
  });
  provider.register();

  const unregister = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new http.HttpInstrumentation(),
      new undici.UndiciInstrumentation(),
      // Statement text only, never parameters (architecture §7.7).
      new pg.PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false }),
      new fastify.FastifyOtelInstrumentation({ registerOnInitialization: true }),
    ],
  });
  await waitForAllMessagesAcknowledged();

  return {
    async shutdown() {
      unregister();
      await provider.shutdown();
    },
  };
}
