import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { ScrubbingSpanProcessor, startTelemetry } from './telemetry.ts';

describe('ScrubbingSpanProcessor', () => {
  it('scrubs URL attributes set at start and before the span ends', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new ScrubbingSpanProcessor(new SimpleSpanProcessor(exporter))] });
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('GET', {
      attributes: { 'url.full': 'https://forms.example.in/f/kyc?email=a@b.in&lang=hi', 'url.query': 'pan=ABCDE1234F&utm_source=x' },
    });
    span.setAttribute('http.target', '/s/secret-token?x=1');
    span.setAttribute('url.path', '/v1/forms?email=a@b.in');
    span.end();
    await provider.forceFlush();
    const [finished] = exporter.getFinishedSpans();
    expect(finished?.attributes).toMatchObject({
      'url.full': 'https://forms.example.in/f/kyc?lang=hi',
      'url.query': 'utm_source',
      'http.target': '/s/:token',
      'url.path': '/v1/forms',
    });
    await provider.shutdown();
  });
});

describe('startTelemetry', () => {
  it('stays off without an OTLP endpoint', async () => {
    expect(await startTelemetry({ serviceName: 'test', sampleRatio: 1 })).toBeUndefined();
    expect(await startTelemetry({ endpoint: '', serviceName: 'test', sampleRatio: 1 })).toBeUndefined();
  });
});
