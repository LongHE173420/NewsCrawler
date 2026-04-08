import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { execFile } from 'child_process';
import { ENV } from '../config/env';
import { Log } from '../utils/log';
import { slugifyFileName } from '../utils/crawl-utils';

type AppLogger = ReturnType<typeof Log.getLogger>;

export class VideoDownloaderService {
    constructor(private logger: AppLogger) { }

    ensureDir(dir: string) {
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch (e: any) {
            this.logger.error('ENSURE_DIR_FAIL', { dir, err: e.message });
        }
    }

    async safeUnlink(filePath: string) {
        try {
            await fs.promises.unlink(filePath);
        } catch (e: any) {
            if (e?.code !== 'ENOENT') {
                this.logger.warn('FILE_DELETE_FAIL', { filePath, err: e.message });
            }
        }
    }

    buildVideoFilePath(newsId: number, title: string, videoDir: string): string {
        return path.join(videoDir, `${slugifyFileName(title)}-${newsId}.mp4`);
    }

    /** Tìm file video cùng title slug (bất kể newsId) để tránh download lại. */
    findExistingVideoFile(title: string, videoDir: string): string | null {
        try {
            const slug = slugifyFileName(title);
            if (!fs.existsSync(videoDir)) return null;
            const files = fs.readdirSync(videoDir);
            const match = files.find(f => f.startsWith(`${slug}-`) && f.endsWith('.mp4'));
            return match ? path.join(videoDir, match) : null;
        } catch {
            return null;
        }
    }

    private async runFfmpeg(args: string[]) {
        try {
            await new Promise<void>((resolve, reject) => {
                execFile(ENV.FFMPEG_PATH, args, (error, _stdout, stderr) => {
                    if (error) {
                        reject(new Error(stderr?.trim() || error.message));
                        return;
                    }
                    resolve();
                });
            });
        } catch (e: any) {
            this.logger.error('FFMPEG_ERROR', { err: e.message });
            throw e;
        }
    }

    private async downloadBinaryFile(url: string, outputPath: string, refererUrl?: string) {
        try {
            await new Promise<void>((resolve, reject) => {
                const file = fs.createWriteStream(outputPath);
                const protocol = url.startsWith('https') ? https : http;
                const request = protocol.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        Referer: refererUrl || `${new URL(url).origin}/`,
                    },
                }, (response) => {
                    if (response.statusCode !== 200) {
                        file.close();
                        fs.unlink(outputPath, () => undefined);
                        reject(new Error(`HTTP ${response.statusCode}`));
                        return;
                    }
                    response.pipe(file);
                    file.on('finish', () => file.close(() => resolve()));
                });

                request.on('error', (err) => {
                    file.close();
                    fs.unlink(outputPath, () => undefined);
                    reject(err);
                });

                file.on('error', (err) => {
                    file.close();
                    fs.unlink(outputPath, () => undefined);
                    reject(err);
                });
            });
        } catch (e: any) {
            this.logger.error('BINARY_DOWNLOAD_ERROR', { url, err: e.message });
            throw e;
        }
    }

    async downloadVideo(
        newsId: number,
        title: string,
        videoUrl: string,
        videoDir: string,
        refererUrl?: string
    ): Promise<string | null> {
        const filePath = this.buildVideoFilePath(newsId, title, videoDir);
        const tempPath = path.join(videoDir, `${slugifyFileName(title)}-${newsId}.tmp.mp4`);

        try {
            this.ensureDir(videoDir);
            await this.safeUnlink(tempPath);
            await this.safeUnlink(filePath);

            this.logger.info('VIDEO_DOWNLOAD_START', { newsId, title, videoUrl, filePath });

            if (videoUrl.toLowerCase().includes('.m3u8')) {
                const referer = refererUrl || `${new URL(videoUrl).origin}/`;
                const origin = new URL(referer).origin;
                await this.runFfmpeg([
                    '-y',
                    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                    '-allowed_extensions', 'ALL',
                    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    '-headers', `Referer: ${referer}\r\nOrigin: ${origin}\r\n`,
                    '-i', videoUrl,
                    '-movflags', '+faststart',
                    '-c:v', 'copy',
                    '-c:a', 'copy',
                    '-bsf:a', 'aac_adtstoasc',
                    tempPath,
                ]);
            } else {
                await this.downloadBinaryFile(videoUrl, tempPath, refererUrl);
            }

            const stat = await fs.promises.stat(tempPath);
            if (!stat.size || stat.size < 4096) {
                throw new Error(`Downloaded file too small: ${stat.size} bytes`);
            }

            await fs.promises.rename(tempPath, filePath);
            this.logger.info('VIDEO_DOWNLOAD_SUCCESS', { newsId, filePath });
            return filePath;
        } catch (e: any) {
            this.logger.error('VIDEO_DOWNLOAD_FAIL', { newsId, videoUrl, err: e.message });
            await this.safeUnlink(filePath);
            await this.safeUnlink(tempPath);
            return null;
        }
    }
}
