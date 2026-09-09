import type { PluginContext } from "@getpaseo/plugin";
import { readFile, rename, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { historyRpc, snapshotRpc, DISK_PATH, type Bucket, type HistoryWindow } from "./contract";
import { SystemMonitor } from "./monitor.client";

// ВАЖНО: никакого async/await в этом файле — он компилируется и в клиентский бандл,
// а компилятор 0.6.1 не понижает синтаксис для Hermes. Только промис-цепочки.

// node:*-импорты в клиентском бандле стабятся в {} — так отличаем сервер от клиента.
const IS_SERVER = typeof readFile === "function";

const SAMPLE_MS = 5_000;
const DISK_MS = 60_000;
const SAVE_MS = 60_000;

interface SeriesSpec {
  window: HistoryWindow;
  stepMs: number;
  capacity: number;
}

const SERIES: SeriesSpec[] = [
  { window: "1h", stepMs: 5_000, capacity: 720 },
  { window: "24h", stepMs: 60_000, capacity: 1440 },
  { window: "7d", stepMs: 900_000, capacity: 672 },
];

// Внутренний бакет: копим сумму и счётчик, avg считаем при отдаче.
interface RawBucket {
  ts: number;
  cpuSum: number;
  cpuMax: number;
  ramSum: number;
  ramMax: number;
  disk: number;
  n: number;
}

interface CpuCounters {
  busy: number;
  total: number;
}

interface SamplerState {
  series: Record<HistoryWindow, RawBucket[]>;
  prevCpu: CpuCounters | null;
  lastCpuPct: number;
  lastRamPct: number;
  lastRamUsed: number;
  lastRamTotal: number;
  lastDiskPct: number;
  lastDiskUsed: number;
  lastDiskTotal: number;
  cores: number;
  dirty: boolean;
  timers: ReturnType<typeof setInterval>[];
}

const state: SamplerState = {
  series: { "1h": [], "24h": [], "7d": [] },
  prevCpu: null,
  lastCpuPct: 0,
  lastRamPct: 0,
  lastRamUsed: 0,
  lastRamTotal: 0,
  lastDiskPct: 0,
  lastDiskUsed: 0,
  lastDiskTotal: 0,
  cores: 0,
  dirty: false,
  timers: [],
};

function statePath(): string {
  return homedir() + "/.paseo-system-monitor.json";
}

function readCpu(): Promise<CpuCounters | null> {
  return readFile("/proc/stat", "utf8").then(
    (text) => {
      const line = text.split("\n")[0] ?? "";
      const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
      if (fields.length < 8 || fields.some(Number.isNaN)) return null;
      const total = fields.reduce((sum, v) => sum + v, 0);
      const idle = fields[3] + fields[4]; // idle + iowait
      return { busy: total - idle, total };
    },
    (error) => {
      console.error("sysmon: /proc/stat read failed:", error);
      return null;
    },
  );
}

function readRam(): Promise<{ pct: number; used: number; total: number } | null> {
  return readFile("/proc/meminfo", "utf8").then(
    (text) => {
      const grab = (key: string) => {
        const m = text.match(new RegExp("^" + key + ":\\s+(\\d+) kB", "m"));
        return m ? Number(m[1]) * 1024 : NaN;
      };
      const total = grab("MemTotal");
      const available = grab("MemAvailable");
      if (Number.isNaN(total) || Number.isNaN(available) || total <= 0) return null;
      const used = total - available;
      return { pct: (used / total) * 100, used, total };
    },
    (error) => {
      console.error("sysmon: /proc/meminfo read failed:", error);
      return null;
    },
  );
}

function readDisk(): Promise<{ pct: number; used: number; total: number } | null> {
  return statfs(DISK_PATH).then(
    (fs) => {
      const used = (fs.blocks - fs.bfree) * fs.bsize;
      const avail = fs.bavail * fs.bsize;
      if (used + avail <= 0) return null;
      // Проценты по формуле df: used / (used + avail), без учёта root-резерва.
      return { pct: (used / (used + avail)) * 100, used, total: used + avail };
    },
    (error) => {
      console.error("sysmon: statfs failed:", error);
      return null;
    },
  );
}

function readUptime(): Promise<number> {
  return readFile("/proc/uptime", "utf8").then(
    (text) => Math.floor(Number(text.split(" ")[0]) || 0),
    () => 0,
  );
}

function countCores(): Promise<number> {
  return readFile("/proc/stat", "utf8").then(
    (text) => text.split("\n").filter((line) => /^cpu\d+\s/.test(line)).length,
    () => 0,
  );
}

function record(now: number, cpuPct: number, ramPct: number) {
  for (const spec of SERIES) {
    const buckets = state.series[spec.window];
    const ts = Math.floor(now / spec.stepMs) * spec.stepMs;
    let last = buckets[buckets.length - 1];
    if (!last || last.ts !== ts) {
      last = { ts, cpuSum: 0, cpuMax: 0, ramSum: 0, ramMax: 0, disk: state.lastDiskPct || -1, n: 0 };
      buckets.push(last);
      if (buckets.length > spec.capacity) buckets.splice(0, buckets.length - spec.capacity);
    }
    last.cpuSum += cpuPct;
    last.cpuMax = Math.max(last.cpuMax, cpuPct);
    last.ramSum += ramPct;
    last.ramMax = Math.max(last.ramMax, ramPct);
    if (state.lastDiskTotal > 0) last.disk = state.lastDiskPct;
    last.n += 1;
  }
  state.dirty = true;
}

function sampleOnce() {
  Promise.all([readCpu(), readRam()]).then(([cpu, ram]) => {
    if (!cpu || !ram) return; // ошибка уже в логе, сэмпл пропускаем
    const prev = state.prevCpu;
    state.prevCpu = cpu;
    if (!prev || cpu.total <= prev.total) return; // первый сэмпл — только базлайн
    const cpuPct = Math.min(100, Math.max(0, ((cpu.busy - prev.busy) / (cpu.total - prev.total)) * 100));
    state.lastCpuPct = cpuPct;
    state.lastRamPct = ram.pct;
    state.lastRamUsed = ram.used;
    state.lastRamTotal = ram.total;
    record(Date.now(), cpuPct, ram.pct);
  });
}

function sampleDisk() {
  readDisk().then((disk) => {
    if (!disk) return;
    state.lastDiskPct = disk.pct;
    state.lastDiskUsed = disk.used;
    state.lastDiskTotal = disk.total;
  });
}

function saveState(): Promise<void> {
  if (!state.dirty) return Promise.resolve();
  state.dirty = false;
  const path = statePath();
  const payload = JSON.stringify({ v: 1, series: state.series });
  // tmp + rename, чтобы падение демона посреди записи не оставило битый JSON
  return writeFile(path + ".tmp", payload, "utf8")
    .then(() => rename(path + ".tmp", path))
    .catch((error) => {
      console.error("sysmon: state save failed:", error);
    });
}

function loadState(): Promise<void> {
  return readFile(statePath(), "utf8").then(
    (text) => {
      const parsed = JSON.parse(text) as { v?: number; series?: Record<string, RawBucket[]> };
      if (parsed.v !== 1 || !parsed.series) return;
      const now = Date.now();
      for (const spec of SERIES) {
        const loaded = parsed.series[spec.window];
        if (!Array.isArray(loaded)) continue;
        const horizon = now - spec.stepMs * spec.capacity;
        state.series[spec.window] = loaded
          .filter((b) => b && typeof b.ts === "number" && b.ts >= horizon && b.n > 0)
          .slice(-spec.capacity);
      }
    },
    () => {
      // первого запуска файла нет — это норма
    },
  );
}

function startSampler() {
  countCores().then((cores) => {
    state.cores = cores;
  });
  loadState().then(() => {
    sampleDisk();
    sampleOnce(); // базлайн CPU
    state.timers.push(setInterval(sampleOnce, SAMPLE_MS));
    state.timers.push(setInterval(sampleDisk, DISK_MS));
    state.timers.push(setInterval(saveState, SAVE_MS));
    console.log("sysmon: sampler started");
  });
}

function stopSampler(): Promise<void> {
  for (const timer of state.timers) clearInterval(timer);
  state.timers = [];
  return saveState();
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(snapshotRpc, () => {
    return readUptime().then((uptimeSec) => ({
      cpuPct: state.lastCpuPct,
      cores: state.cores,
      ramPct: state.lastRamPct,
      ramUsedBytes: state.lastRamUsed,
      ramTotalBytes: state.lastRamTotal,
      diskPct: state.lastDiskPct,
      diskUsedBytes: state.lastDiskUsed,
      diskTotalBytes: state.lastDiskTotal,
      uptimeSec,
    }));
  });

  plugin.handle(historyRpc, ({ window }) => {
    const spec = SERIES.find((s) => s.window === window);
    const buckets: Bucket[] = (spec ? state.series[window] : []).map((b) => ({
      ts: b.ts,
      cpuAvg: b.n > 0 ? b.cpuSum / b.n : 0,
      cpuMax: b.cpuMax,
      ramAvg: b.n > 0 ? b.ramSum / b.n : 0,
      ramMax: b.ramMax,
      disk: b.disk,
    }));
    return Promise.resolve({ stepMs: spec ? spec.stepMs : 0, buckets });
  });

  plugin.addSurface("main", SystemMonitor);
  plugin.addSidebarItem({
    id: "main",
    title: "System monitor",
    icon: "Activity",
    surface: "main",
  });

  if (IS_SERVER) startSampler();

  return () => {
    if (IS_SERVER) return stopSampler();
  };
}
