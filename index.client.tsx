import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SystemMonitor } from "./client/monitor";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", SystemMonitor);
  client.addSidebarItem({
    id: "main",
    title: "System monitor",
    icon: "Activity",
    surface: "main",
  });
  return () => {};
}
