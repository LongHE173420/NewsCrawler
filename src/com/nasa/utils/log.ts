import pino, { Logger as PinoLogger } from "pino";
import fs from "fs";
import path from "path";
import { Writable } from "stream";
import { ENV } from "../config/env";

export function ensureLogDir(): string {
  const dir = path.resolve(process.cwd(), ENV.LOG_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getTodayLogPath() {
  const dir = ensureLogDir();
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const fileName = `news-crawler-${yyyy}-${mm}-${dd}.log`;
  const filePath = path.join(dir, fileName);
  return { fileName, filePath };
}

function tryDeleteLog(fp: string, cutoff: number) {
  try {
    if (!fs.existsSync(fp)) return;
    const st = fs.statSync(fp);
    if (!st.isFile()) return;
    if (st.mtimeMs < cutoff) fs.rmSync(fp, { force: true });
  } catch {
    // ignore
  }
}

export function cleanupOldLogs() {
  const dir = ensureLogDir();
  const days = ENV.LOG_RETENTION_DAYS;
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(dir)) {
      tryDeleteLog(path.join(dir, name), cutoff);
    }
  } catch (e) {}
}

type LogLevel = "debug" | "info" | "warn" | "error";
const multistream = (pino as any).multistream as (streams: any[]) => any;

function levelToLabel(level?: number): string {
  switch (level) {
    case 20:
      return "DEBUG";
    case 30:
      return "INFO ";
    case 40:
      return "WARN ";
    case 50:
      return "ERROR";
    case 60:
      return "FATAL";
    default:
      return "LOG  ";
  }
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, max = 88): string {
  const normalized = normalizeInlineText(value);
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function formatValue(value: any): string {
  if (value == null) return "null";
  if (typeof value === "string") return `'${truncateText(value)}'`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length <= 3 && value.every(item => ["string", "number", "boolean"].includes(typeof item))) {
      return `[${value.map(item => formatValue(item)).join(", ")}]`;
    }
    return `[${value.length} items]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    const preview = entries.slice(0, 4).map(([k, v]) => `${k}:${formatValue(v)}`).join(", ");
    return `{${preview}${entries.length > 4 ? ", ..." : ""}}`;
  }

  return String(value);
}

function formatExtraFields(extra: Record<string, any>): string {
  const keys = Object.keys(extra);
  if (keys.length === 0) return "";

  const orderedKeys = [
    "seedUrl",
    "source",
    "url",
    "title",
    "newsId",
    "found",
    "savedCount",
    "limit",
    "perWorkerLimit",
    "filePath",
    "videoUrl",
    "err",
  ];

  const sortedKeys = [
    ...orderedKeys.filter(key => key in extra),
    ...keys.filter(key => !orderedKeys.includes(key)).sort(),
  ];

  const rendered = sortedKeys
    .slice(0, 8)
    .map(key => `${key}=${formatValue(extra[key])}`)
    .join(" ");

  return rendered ? ` ${rendered}` : "";
}

function formatDurationMs(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "0s";

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${totalSeconds}s`;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function formatShortPath(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return value.replace(/^.*[\\/]/, "");
}

function formatLabel(value: unknown, max = 48): string {
  if (value == null) return "-";
  return truncateText(String(value), max);
}

function shouldDisplayConsole(parsed: Record<string, any>): boolean {
  const level = Number(parsed.level || 0);
  if (level >= 40) return true;

  const visibleInfoMessages = new Set([
    "BOOTSTRAP_READY",
    "MASTER_WORKER_STARTING",
    "SPAWNED_WORKER_FOR_SEED",
    "SEED_SCAN_START",
    "SEED_SCAN_DONE",
    "VIDEO_DOWNLOAD_SUCCESS",
    "VIDEO_DOWNLOAD_FAIL",
    "WORKER_SUMMARY",
    "MASTER_SUMMARY",
  ]);

  return visibleInfoMessages.has(parsed.msg || "");
}

function formatConsoleEvent(parsed: Record<string, any>, extra: Record<string, any>): string | null {
  const time = parsed.time || new Date().toISOString().slice(11, 19);
  const level = levelToLabel(parsed.level);
  const logger = parsed.logger || parsed.app || "app";
  const msg = parsed.msg || "";

  if (!shouldDisplayConsole(parsed)) {
    return null;
  }

  switch (msg) {
    case "BOOTSTRAP_READY":
      return `[${time}] READY  db=${formatValue(extra.dbName)} log=${formatValue(formatShortPath(extra.logFile))}`;
    case "MASTER_WORKER_STARTING":
      return `[${time}] START  master seeds=${extra.seedsCount ?? 0}`;
    case "SPAWNED_WORKER_FOR_SEED":
      return `[${time}] WORKER ${formatLabel(extra.seedUrl) } limit=${extra.perWorkerLimit ?? 0}`;
    case "SEED_SCAN_START":
      return `[${time}] SCAN   ${formatLabel(extra.source, 20)} ${formatLabel(extra.seedUrl)}`;
    case "SEED_SCAN_DONE":
      return `[${time}] FOUND  ${formatLabel(extra.source, 20)} found=${extra.found ?? 0}`;
    case "VIDEO_DOWNLOAD_SUCCESS":
      return `[${time}] VIDEO  saved newsId=${extra.newsId ?? "?"} file=${formatValue(formatShortPath(extra.filePath))}`;
    case "VIDEO_DOWNLOAD_FAIL":
      return `[${time}] VIDEO  fail newsId=${extra.newsId ?? "?"} err=${formatValue(extra.err)}`;
    case "WORKER_SUMMARY":
      return `[${time}] DONE   ${formatLabel(extra.source || extra.seedUrl, 20)} found=${extra.foundCount ?? 0} saved=${extra.savedCount ?? 0} existing=${extra.existingCount ?? 0} video=${extra.videoDownloadedCount ?? 0}/${extra.videoAttemptedCount ?? 0} fail=${extra.videoFailedCount ?? 0} noVideo=${extra.noVideoCount ?? 0} time=${formatDurationMs(extra.durationMs)}`;
    case "MASTER_SUMMARY":
      return `[${time}] TOTAL  workers=${extra.workers ?? 0} found=${extra.foundCount ?? 0} saved=${extra.savedCount ?? 0} existing=${extra.existingCount ?? 0} video=${extra.videoDownloadedCount ?? 0}/${extra.videoAttemptedCount ?? 0} fail=${extra.videoFailedCount ?? 0} noVideo=${extra.noVideoCount ?? 0} time=${formatDurationMs(extra.durationMs)}`;
    default:
      return `[${time}] ${level} [${logger}] ${msg}${formatExtraFields(extra)}`;
  }
}

function formatConsoleLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed) as Record<string, any>;

    const extra: Record<string, any> = { ...parsed };
    delete extra.level;
    delete extra.time;
    delete extra.logger;
    delete extra.app;
    delete extra.msg;
    delete extra.pid;
    delete extra.hostname;

    return formatConsoleEvent(parsed, extra) || "";
  } catch {
    return trimmed;
  }
}

function createPrettyConsoleStream() {
  let pending = "";
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";

        for (const line of lines) {
          const formatted = formatConsoleLine(line);
          if (formatted) {
            process.stdout.write(`${formatted}\n`);
          }
        }
        callback();
      } catch (err) {
        callback(err as Error);
      }
    }
  });
}

export class Log {
  private static root: PinoLogger;
  private static initialized = false;

  static init(opts?: {
    appName?: string;
    level?: LogLevel;
    filePath?: string;
  }) {
    if (this.initialized) return;

    const baseConfig = {
      level: opts?.level ?? "info",
      base: { app: opts?.appName },
      timestamp: () => `,"time":"${new Date().toISOString().split('T')[1].split('Z')[0]}"`,
    };

    if (opts?.filePath) {
      const fileStream = pino.destination({ dest: opts.filePath, sync: false });
      const streams: any[] = [{ stream: fileStream }];
      if (ENV.LOG_CONSOLE) {
        streams.push({ stream: createPrettyConsoleStream() });
      }
      this.root = pino(baseConfig, multistream(streams));
    } else {
      if (ENV.LOG_CONSOLE) {
        this.root = pino(baseConfig, createPrettyConsoleStream() as any);
      } else {
        this.root = pino({ ...baseConfig, level: "silent" });
      }
    }
    this.initialized = true;
  }

  static getLogger(name: string) {
    if (!this.initialized) this.init();
    const logger = this.root.child({ logger: name });
    return {
      debug: (msg: string, obj?: any) => logger.debug(obj || {}, msg),
      info: (msg: string, obj?: any) => logger.info(obj || {}, msg),
      warn: (msg: string, obj?: any) => logger.warn(obj || {}, msg),
      error: (msg: string, obj?: any) => logger.error(obj || {}, msg),
    };
  }
}
