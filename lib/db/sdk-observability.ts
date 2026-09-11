import "server-only";

import { getDb } from "./schema";
import {
  SdkObservabilityStore,
  type RecentSdkEventQuery,
  type SdkEventIngestResult,
  type SdkObservabilityContext,
  type SdkUsageQuery,
} from "./sdk-observability-store";

export type {
  RecentSdkEventQuery,
  SdkEventIngestResult,
  SdkModelUsage,
  SdkObservabilityContext,
  SdkObservabilityEventType,
  SdkUsageAggregate,
  SdkUsageQuery,
  StoredSdkObservabilityEvent,
} from "./sdk-observability-store";

function store(): SdkObservabilityStore {
  return new SdkObservabilityStore(getDb());
}

export function ingestSdkObservabilityEvent(
  event: unknown,
  context: SdkObservabilityContext
): SdkEventIngestResult {
  return store().ingest(event, context);
}

export function createSdkObservabilityIngestor(
  context: SdkObservabilityContext
): (event: unknown) => SdkEventIngestResult {
  const eventStore = store();
  return (event) => eventStore.ingest(event, context);
}

export function getRecentSdkObservabilityEvents(query: RecentSdkEventQuery = {}) {
  return store().recent(query);
}

export function getSdkUsageAggregate(query: SdkUsageQuery = {}) {
  return store().aggregateUsage(query);
}
