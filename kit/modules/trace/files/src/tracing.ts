// Tracing of {{kit.name}}. Keep this the FIRST import of src/index.ts: tracing must be set up before the app is
// built, and it is where instrumentations would be registered. It is off until OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { startTracing } from './kit/trace/tracing.js'

export const TRACING = startTracing({ serviceName: '{{kit.name}}-api' })
