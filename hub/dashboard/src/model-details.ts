import type { PeriodUsage, Session } from "./data";
import { outputTokensPerSecond, sessionModelUsage } from "./session-details";

export function modelUsageDetails(period: PeriodUsage, modelId: string) {
  const entity = period.models.find(model => model.id === modelId) ?? null;
  const throughput = period.modelThroughput?.[modelId] ?? null;
  const clients = period.clientModels === undefined ? null : Object.entries(period.clientModels)
    .filter(([, models]) => typeof models[modelId] === "number" && models[modelId] > 0)
    .map(([client, models]) => ({ client, tokens: models[modelId], costUsd: period.clientModelCosts?.[client]?.[modelId] ?? null }));
  // Devices that used this model without reporting timing are left out of the speed.
  const untimedDevices = period.modelThroughputMissing?.[modelId] ?? 0;
  return { entity, throughput, outputTokensPerSecond: throughput ? outputTokensPerSecond(throughput) : null, untimedDevices, clients };
}

export function sessionsForModel(sessions: Session[], modelId: string): Session[] {
  return sessions.filter(session => (sessionModelUsage(session, modelId).tokens ?? 0) > 0 || session.models.includes(modelId));
}
