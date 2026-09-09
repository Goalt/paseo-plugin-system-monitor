import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

// Решения ревью ТЗ (SPEC §10): порог подсветки и единственный наблюдаемый маунт.
export const DANGER_PCT = 90;
export const DISK_PATH = "/";

export const WindowSchema = z.enum(["1h", "24h", "7d"]);
export type HistoryWindow = z.infer<typeof WindowSchema>;

export const BucketSchema = z.object({
  ts: z.number(), // начало бакета, мс epoch
  cpuAvg: z.number(),
  cpuMax: z.number(),
  ramAvg: z.number(),
  ramMax: z.number(),
  disk: z.number(), // % занятости; -1 = в этом бакете диск ещё не измерялся
});
export type Bucket = z.infer<typeof BucketSchema>;

export const SnapshotSchema = z.object({
  cpuPct: z.number(),
  cores: z.number(),
  ramPct: z.number(),
  ramUsedBytes: z.number(),
  ramTotalBytes: z.number(),
  diskPct: z.number(),
  diskUsedBytes: z.number(),
  diskTotalBytes: z.number(),
  uptimeSec: z.number(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const snapshotRpc = defineRpc({
  name: "sysmon.snapshot",
  input: z.object({}),
  output: SnapshotSchema,
});

export const historyRpc = defineRpc({
  name: "sysmon.history",
  input: z.object({ window: WindowSchema }),
  output: z.object({
    stepMs: z.number(),
    buckets: z.array(BucketSchema),
  }),
});
