import dotenv from "dotenv";
import * as path from "path";

dotenv.config();

type Bool = boolean;

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(name: string, def: string): string {
  const v = process.env[name];
  return v == null || v === "" ? def : String(v);
}

function bool(name: string, def: Bool): Bool {
  const v = process.env[name];
  if (v == null || v === "") return def;
  return String(v).toLowerCase() === "true" || String(v) === "1";
}

function strArray(name: string, def: string[]): string[] {
  const v = process.env[name];
  if (v == null || v === "") return def;
  return v.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

export const ENV = {
  LOG_LEVEL: str("LOG_LEVEL", "info"),
  LOG_DIR: str("LOG_DIR", "data/logs"),
  LOG_RETENTION_DAYS: num("LOG_RETENTION_DAYS", 7),
  LOG_CONSOLE: bool("LOG_CONSOLE", true),

  DB_HOST: str("DB_HOST", "127.0.0.1"),
  DB_USER: str("DB_USER", "root"),
  DB_PASS: str("DB_PASS", "Long2002@"),
  DB_NAME: str("DB_NAME", "vn_express_news"),

  CRAWL_NEWS_ENABLED: bool("CRAWL_NEWS_ENABLED", true),
  CRAWL_INTERVAL_MS: num("CRAWL_INTERVAL_MS", 60 * 60_000),
  CRAWL_LIMIT: num("CRAWL_LIMIT", 20),

  VIDEO_DOWNLOAD_DIR: str("VIDEO_DOWNLOAD_DIR", path.resolve("data/videos")),
  MAX_POSTS_PER_NEWS: num("MAX_POSTS_PER_NEWS", 1),

  NEWS_SEED_URLS: strArray("NEWS_SEED_URLS", [
    "https://vnexpress.net",
    "https://dantri.com.vn",
    "https://tuoitre.vn",
    "https://thanhnien.vn",
    "https://zingnews.vn",
  ]),

  FFMPEG_PATH: str("FFMPEG_PATH", "D:\\ffmpeg\\bin\\ffmpeg.exe"),
};

export type Env = typeof ENV;
