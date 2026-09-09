# system-monitor — плагин Paseo

Загруженность сервера во времени: CPU, RAM и диск `/` — текущие значения плюс
исторические графики с окнами **1 час / 24 часа / 7 дней**. Trusted-плагин для
демона Paseo 0.6.1.

## Что измеряется

Плагин читает `/proc/stat`, `/proc/meminfo` и `statfs("/")` на машине демона.
Демон работает в Docker-контейнере **без cgroup-лимитов**, поэтому все метрики —
это метрики **всего хоста VPS**, а не контейнера. Это осознанное решение
(SPEC §2): пользователь видит загруженность всего сервера. Если контейнеру
когда-нибудь выдадут лимиты (`memory.max` ≠ `max`), показания CPU/RAM перестанут
отражать доступные контейнеру ресурсы — тогда сэмплер нужно переводить на cgroup.

- CPU% = 1 − (Δidle + Δiowait) / Δtotal по агрегатной строке `/proc/stat`
- RAM% = (MemTotal − MemAvailable) / MemTotal
- Disk% = used / (used + avail) по statfs — формула df

## Архитектура

```
index.ts            contribute(): server-сэмплер + 2 RPC + регистрация UI
monitor.client.tsx  сурфейс: тайлы, переключатель окон, 3 бар-чарта на View-примитивах
contract.ts         zod-контракты sysmon.snapshot / sysmon.history + константы
docs/SPEC.md        ТЗ v1.1 (утверждено 2026-09-08)
```

Сэмплер: CPU/RAM каждые 5 с, диск каждые 60 с; три кольцевых буфера с avg/max
(5с×720, 1м×1440, 15м×672). История персистится в `~/.paseo-system-monitor.json`
(раз в 60 с + при cleanup) и переживает reload плагина; рестарт демона теряет ≤60 с.

## Установка

```bash
npm install
npm run typecheck
paseo plugin install /absolute/path/to/system-monitor
```

## Ограничения демона 0.6.1

- В клиентском коде запрещены `async`/`await` (компилятор не понижает синтаксис
  для Hermes) — только промис-цепочки; на iOS/Android плагины заработают после
  апгрейда демона до 0.7+.
- Клиентские импорты — только `react`, `react-native`, `@getpaseo/plugin`, zod,
  TanStack Query; поэтому графики нарисованы чистыми `View` (клиент схлопывает
  ряд до ≤120 баров, в compact — ≤60).
- Палитра темы: `surface0`/`foreground`/`foregroundMuted`/`accent`/
  `accentForeground`/`statusDanger`; порог подсветки — 90%.
- Имена RPC — только lowercase/kebab (`sysmon.snapshot`).
