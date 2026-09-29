import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleHistory, handleSnapshot, startSampler, stopSampler } from "./server/sampler";
import { historyRpc, snapshotRpc } from "./shared/contract";

export default function contribute(server: PluginServerContext) {
  server.handle(snapshotRpc, handleSnapshot);
  server.handle(historyRpc, handleHistory);
  startSampler();
  return () => stopSampler();
}
