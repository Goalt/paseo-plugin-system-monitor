import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  historyRpc,
  snapshotRpc,
  DANGER_PCT,
  DISK_PATH,
  type Bucket,
  type HistoryWindow,
  type Snapshot,
} from "./contract";

// ВАЖНО: никакого async/await — компилятор демона 0.6.1 не понижает синтаксис
// для клиентского бандла, Hermes на iOS/Android его не съест. Только промис-цепочки.

const SNAPSHOT_MS = 5_000;
const HISTORY_MS = 15_000;

const WINDOWS: { key: HistoryWindow; label: string }[] = [
  { key: "1h", label: "1 час" },
  { key: "24h", label: "24 часа" },
  { key: "7d", label: "7 дней" },
];

interface HistoryData {
  stepMs: number;
  buckets: Bucket[];
}

interface BarDatum {
  ts: number;
  avg: number;
  max: number;
  empty: boolean;
}

interface Selected {
  chart: string;
  ts: number;
  avg: number;
  max: number;
  single: boolean; // у диска нет avg/max — одно значение
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function fmtTime(ts: number, withDate: boolean): string {
  const d = new Date(ts);
  const hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  return withDate ? pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + " " + hm : hm;
}

function fmtGiB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

function fmtUptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  return days > 0 ? days + " дн " + hours + " ч" : hours + " ч";
}

// Схлопывание ряда под ширину: RN не вывезет 720 баров (SPEC §7).
function collapse(buckets: Bucket[], maxBars: number, pick: (b: Bucket) => { avg: number; max: number } | null): BarDatum[] {
  if (buckets.length === 0) return [];
  const group = Math.max(1, Math.ceil(buckets.length / maxBars));
  const out: BarDatum[] = [];
  for (let i = 0; i < buckets.length; i += group) {
    let sum = 0;
    let max = 0;
    let n = 0;
    for (let j = i; j < Math.min(i + group, buckets.length); j++) {
      const v = pick(buckets[j]);
      if (!v) continue;
      sum += v.avg;
      max = Math.max(max, v.max);
      n += 1;
    }
    out.push({ ts: buckets[i].ts, avg: n > 0 ? sum / n : 0, max, empty: n === 0 });
  }
  return out;
}

export function SystemMonitor({ theme, layout }: PluginSurfaceProps) {
  const callSnapshot = useRpc(snapshotRpc);
  const callHistory = useRpc(historyRpc);

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [win, setWin] = useState<HistoryWindow>("1h");
  const [hist, setHist] = useState<Partial<Record<HistoryWindow, HistoryData>>>({});
  const [sel, setSel] = useState<Selected | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      callSnapshot({}).then(
        (data) => {
          if (!alive) return;
          setSnap(data);
          setOffline(false);
        },
        () => {
          if (alive) setOffline(true);
        },
      );
    };
    tick();
    const timer = setInterval(tick, SNAPSHOT_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [callSnapshot]);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      callHistory({ window: win }).then(
        (data) => {
          if (!alive) return;
          setHist((prev) => ({ ...prev, [win]: data }));
          setOffline(false);
        },
        () => {
          if (alive) setOffline(true);
        },
      );
    };
    tick();
    const timer = setInterval(tick, HISTORY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [callHistory, win]);

  const compact = layout.compact;
  const colors = theme.colors;
  const chartH = compact ? 72 : 100;
  const maxBars = compact ? 60 : 120;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: colors.surface0 },
      content: { padding: compact ? 12 : 20, gap: compact ? 12 : 16 },
      banner: { color: colors.statusDanger, fontSize: 13, fontWeight: "600" as const },
      meta: { color: colors.foregroundMuted, fontSize: 12 },
      tiles: { flexDirection: "row" as const, gap: compact ? 8 : 12 },
      tile: {
        flex: 1,
        padding: compact ? 10 : 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.foregroundMuted,
        gap: 2,
      },
      tileLabel: { color: colors.foregroundMuted, fontSize: 12 },
      tileSub: { color: colors.foregroundMuted, fontSize: 11 },
      segments: { flexDirection: "row" as const, gap: 6 },
      segment: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8 },
      chartCard: { gap: 6 },
      chartTitle: { color: colors.foreground, fontSize: 14, fontWeight: "600" as const },
      chartRow: {
        height: chartH,
        flexDirection: "row" as const,
        alignItems: "flex-end" as const,
        borderBottomWidth: 1,
        borderBottomColor: colors.foregroundMuted,
      },
      axis: { flexDirection: "row" as const, justifyContent: "space-between" as const },
      axisText: { color: colors.foregroundMuted, fontSize: 10 },
      selText: { color: colors.foreground, fontSize: 12 },
      emptyText: { color: colors.foregroundMuted, fontSize: 12, fontStyle: "italic" as const },
    }),
    [colors, compact, chartH],
  );

  const tileValue = (pct: number) => ({
    color: pct >= DANGER_PCT ? colors.statusDanger : colors.foreground,
    fontSize: compact ? 20 : 26,
    fontWeight: "700" as const,
  });

  const data = hist[win];
  const withDate = win === "7d";

  // Деления вертикальной оси; 0% подписывается у базовой линии отдельно.
  const grid = compact ? [100, 50] : [100, 75, 50, 25];
  const gutterW = compact ? 26 : 32;

  const renderChart = (title: string, bars: BarDatum[], single: boolean) => {
    const first = bars.length > 0 ? bars[0].ts : 0;
    const last = bars.length > 0 ? bars[bars.length - 1].ts : 0;
    const mid = bars.length > 0 ? bars[Math.floor(bars.length / 2)].ts : 0;
    return (
      <View style={styles.chartCard} key={title}>
        <Text style={styles.chartTitle}>{title}</Text>
        <View style={{ flexDirection: "row" as const }}>
          <View style={{ width: gutterW, height: chartH }}>
            {grid.concat(0).map((v) => (
              <Text
                key={v}
                style={{
                  position: "absolute" as const,
                  right: 4,
                  bottom: v === 0 ? -3 : Math.min(chartH - 10, (chartH * v) / 100 - 5),
                  fontSize: 9,
                  color: colors.foregroundMuted,
                }}
              >
                {v + "%"}
              </Text>
            ))}
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.chartRow}>
              {grid.map((v) => (
                <View
                  key={"grid" + v}
                  style={{
                    position: "absolute" as const,
                    left: 0,
                    right: 0,
                    bottom: Math.min(chartH - 1, (chartH * v) / 100),
                    height: 1,
                    backgroundColor: colors.foregroundMuted,
                    opacity: 0.25,
                  }}
                />
              ))}
              {bars.length === 0 ? (
                <View
                  style={{
                    position: "absolute" as const,
                    left: 0,
                    right: 0,
                    top: 0,
                    bottom: 0,
                    alignItems: "center" as const,
                    justifyContent: "center" as const,
                  }}
                >
                  <Text style={styles.emptyText}>данные ещё копятся…</Text>
                </View>
              ) : null}
              {bars.map((bar) => {
              const danger = bar.avg >= DANGER_PCT;
              const avgH = Math.max(bar.empty ? 0 : 1, Math.round((chartH * Math.min(100, bar.avg)) / 100));
              const maxH = Math.round((chartH * Math.min(100, bar.max)) / 100);
              return (
                <Pressable
                  key={bar.ts}
                  accessibilityRole="button"
                  accessibilityLabel={title + " " + fmtTime(bar.ts, withDate) + ": " + Math.round(bar.avg) + "%"}
                  onPress={() =>
                    setSel({ chart: title, ts: bar.ts, avg: bar.avg, max: bar.max, single })
                  }
                  style={{ flex: 1, height: chartH, justifyContent: "flex-end" as const, paddingHorizontal: 0.5 }}
                >
                  {!single && maxH > avgH ? (
                    <View
                      style={{
                        position: "absolute" as const,
                        left: 0.5,
                        right: 0.5,
                        bottom: maxH - 1,
                        height: 1,
                        backgroundColor: bar.max >= DANGER_PCT ? colors.statusDanger : colors.foregroundMuted,
                      }}
                    />
                  ) : null}
                  <View
                    style={{
                      height: avgH,
                      borderTopLeftRadius: 1,
                      borderTopRightRadius: 1,
                      backgroundColor: danger ? colors.statusDanger : colors.accent,
                      opacity: bar.empty ? 0 : 1,
                    }}
                  />
                </Pressable>
              );
            })}
            </View>
            <View style={styles.axis}>
              <Text style={styles.axisText}>{first ? fmtTime(first, withDate) : ""}</Text>
              <Text style={styles.axisText}>{mid ? fmtTime(mid, withDate) : ""}</Text>
              <Text style={styles.axisText}>{last ? fmtTime(last, withDate) : ""}</Text>
            </View>
          </View>
        </View>
        {sel && sel.chart === title ? (
          <Text style={styles.selText}>
            {fmtTime(sel.ts, withDate)} —{" "}
            {sel.single
              ? Math.round(sel.avg) + "%"
              : "avg " + sel.avg.toFixed(1) + "%, max " + sel.max.toFixed(1) + "%"}
          </Text>
        ) : null}
      </View>
    );
  };

  const cpuBars = useMemo(
    () => collapse(data ? data.buckets : [], maxBars, (b) => ({ avg: b.cpuAvg, max: b.cpuMax })),
    [data, maxBars],
  );
  const ramBars = useMemo(
    () => collapse(data ? data.buckets : [], maxBars, (b) => ({ avg: b.ramAvg, max: b.ramMax })),
    [data, maxBars],
  );
  const diskBars = useMemo(
    () =>
      collapse(data ? data.buckets : [], maxBars, (b) =>
        b.disk >= 0 ? { avg: b.disk, max: b.disk } : null,
      ),
    [data, maxBars],
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {offline ? <Text style={styles.banner}>Нет связи с сэмплером — показаны последние данные</Text> : null}

      <View style={styles.tiles}>
        <View style={styles.tile}>
          <Text style={styles.tileLabel}>CPU</Text>
          <Text style={tileValue(snap ? snap.cpuPct : 0)}>
            {snap ? Math.round(snap.cpuPct) + "%" : "—"}
          </Text>
          <Text style={styles.tileSub}>{snap && snap.cores > 0 ? snap.cores + " ядер" : " "}</Text>
        </View>
        <View style={styles.tile}>
          <Text style={styles.tileLabel}>RAM</Text>
          <Text style={tileValue(snap ? snap.ramPct : 0)}>
            {snap ? Math.round(snap.ramPct) + "%" : "—"}
          </Text>
          <Text style={styles.tileSub}>
            {snap && snap.ramTotalBytes > 0
              ? fmtGiB(snap.ramUsedBytes) + " / " + fmtGiB(snap.ramTotalBytes) + " GiB"
              : " "}
          </Text>
        </View>
        <View style={styles.tile}>
          <Text style={styles.tileLabel}>Диск {DISK_PATH}</Text>
          <Text style={tileValue(snap ? snap.diskPct : 0)}>
            {snap ? Math.round(snap.diskPct) + "%" : "—"}
          </Text>
          <Text style={styles.tileSub}>
            {snap && snap.diskTotalBytes > 0
              ? fmtGiB(snap.diskUsedBytes) + " / " + fmtGiB(snap.diskTotalBytes) + " GiB"
              : " "}
          </Text>
        </View>
      </View>

      {snap && snap.uptimeSec > 0 ? (
        <Text style={styles.meta}>Метрики всего хоста VPS · аптайм {fmtUptime(snap.uptimeSec)}</Text>
      ) : null}

      <View style={styles.segments}>
        {WINDOWS.map((w) => {
          const active = w.key === win;
          return (
            <Pressable
              key={w.key}
              accessibilityRole="button"
              accessibilityLabel={"Окно " + w.label}
              onPress={() => {
                setWin(w.key);
                setSel(null);
              }}
              style={[
                styles.segment,
                {
                  backgroundColor: active ? colors.accent : "transparent",
                  borderWidth: 1,
                  borderColor: active ? colors.accent : colors.foregroundMuted,
                },
              ]}
            >
              <Text
                style={{
                  color: active ? colors.accentForeground : colors.foregroundMuted,
                  fontSize: 13,
                  fontWeight: "600" as const,
                }}
              >
                {w.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {renderChart("CPU", cpuBars, false)}
      {renderChart("RAM", ramBars, false)}
      {renderChart("Диск " + DISK_PATH, diskBars, true)}
    </ScrollView>
  );
}
