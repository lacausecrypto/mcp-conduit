/**
 * Intégration OpenTelemetry pour Conduit.
 *
 * Initialise le SDK OTEL avec :
 * - Export des traces via OTLP HTTP
 * - Propagation W3C Trace Context
 * - Service name configurable
 * - Sample rate configurable
 *
 * N'est activé que si config.observability.opentelemetry.enabled est true.
 * Les métriques Prometheus existantes (prom-client) ne sont PAS remplacées.
 */

import { trace, type Tracer, type Span, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-node';

/** Configuration OpenTelemetry */
export interface OtelConfig {
  enabled: boolean;
  endpoint: string;
  service_name: string;
  sample_rate?: number;
}

let provider: NodeTracerProvider | null = null;
let conduitTracer: Tracer | null = null;

/**
 * Initialise le SDK OpenTelemetry.
 * Doit être appelé au démarrage de la passerelle.
 */
export function initOtel(config: OtelConfig): void {
  if (!config.enabled) return;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.service_name,
    [ATTR_SERVICE_VERSION]: '0.1.0',
  });

  const sampleRate = config.sample_rate ?? 1.0;
  const sampler = new TraceIdRatioBasedSampler(sampleRate);

  provider = new NodeTracerProvider({
    resource,
    sampler,
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: config.endpoint }),
      ),
    ],
  });

  provider.register();
  conduitTracer = trace.getTracer('conduit', '0.1.0');

  console.log(`[Conduit] OpenTelemetry: traces enabled → ${config.endpoint} (sample_rate=${sampleRate})`);
}

/**
 * Arrête proprement le SDK OpenTelemetry.
 */
export async function shutdownOtel(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
    conduitTracer = null;
  }
}

/**
 * Retourne le tracer Conduit ou null si OTEL n'est pas activé.
 */
export function getTracer(): Tracer | null {
  return conduitTracer;
}

/**
 * Helper pour instrumenter une opération avec un span OTEL.
 * Si OTEL n'est pas activé, exécute simplement la fonction.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span | null) => Promise<T>,
): Promise<T> {
  const tracer = conduitTracer;
  if (!tracer) {
    return fn(null);
  }

  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }

    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
