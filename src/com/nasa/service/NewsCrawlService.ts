import * as path from 'path';
import { MysqlStore } from '../data/MysqlStore';
import { ENV } from '../config/env';
import { Log } from '../utils/log';
import { detectSource, extractCategorySlug } from '../config/sources';
import { canonicalizeUrl } from '../utils/crawl-utils';
import { ArticleExtractorService } from './ArticleExtractorService';
import { VideoDownloaderService } from './VideoDownloaderService';
import { CrawlSummary, ProcessArticleResult } from '../types/news.types';

export type { CrawlSummary } from '../types/news.types';

type AppLogger = ReturnType<typeof Log.getLogger>;

export class NewsCrawlService {
    private extractor: ArticleExtractorService;
    private downloader: VideoDownloaderService;

    constructor(private logger: AppLogger) {
        this.extractor = new ArticleExtractorService(logger);
        this.downloader = new VideoDownloaderService(logger);
    }

    private createSummary(seedUrl: string, limit: number): CrawlSummary {
        return {
            seedUrl,
            source: detectSource(seedUrl),
            limit,
            foundCount: 0,
            scannedCount: 0,
            savedCount: 0,
            existingCount: 0,
            extractFailedCount: 0,
            videoAttemptedCount: 0,
            videoDownloadedCount: 0,
            videoFailedCount: 0,
            noVideoCount: 0,
            durationMs: 0,
        };
    }

    private mergeSummary(target: CrawlSummary, incoming: CrawlSummary) {
        target.foundCount += incoming.foundCount;
        target.scannedCount += incoming.scannedCount;
        target.savedCount += incoming.savedCount;
        target.existingCount += incoming.existingCount;
        target.extractFailedCount += incoming.extractFailedCount;
        target.videoAttemptedCount += incoming.videoAttemptedCount;
        target.videoDownloadedCount += incoming.videoDownloadedCount;
        target.videoFailedCount += incoming.videoFailedCount;
        target.noVideoCount += incoming.noVideoCount;
        target.durationMs += incoming.durationMs;
    }

    private async processSingleArticle(
        url: string,
        videoDir: string,
        categoryId: number | null = null
    ): Promise<ProcessArticleResult> {
        try {
            const normalizedUrl = canonicalizeUrl(url);

            const article = await this.extractor.extractArticle(normalizedUrl);
            if (!article) {
                this.logger.warn('ARTICLE_EXTRACT_FAILED', { url: normalizedUrl });
                return { saved: false, alreadyExists: false, extractFailed: true, hadVideo: false, videoDownloaded: false, videoFailed: false };
            }

            const newsId = await MysqlStore.saveCrawledNews({
                source: article.source,
                source_url: article.source_url,
                category_id: categoryId,
                title: article.title,
                description: article.description,
                image_url: article.image_url,
                video_url: article.video_url,
                author: article.author,
            });

            if (!newsId) {
                this.logger.debug('ARTICLE_ALREADY_EXISTS', { url: article.source_url });
                return { saved: false, alreadyExists: true, extractFailed: false, hadVideo: Boolean(article.video_url), videoDownloaded: false, videoFailed: false };
            }

            const hadVideo = Boolean(article.video_url);

            if (hadVideo) {
                // Ưu tiên 1: file đúng path của newsId này
                const expectedPath = this.downloader.buildVideoFilePath(newsId, article.title, videoDir);
                const fs = await import('fs');
                if (fs.existsSync(expectedPath)) {
                    this.logger.debug('VIDEO_ALREADY_EXISTS_EXACT', { newsId, path: expectedPath });
                    await MysqlStore.saveLocalPath(newsId, expectedPath);
                    return { saved: true, alreadyExists: false, extractFailed: false, hadVideo: true, videoDownloaded: true, videoFailed: false };
                }

                // Ưu tiên 2: file cùng title slug đã tồn tại
                const dupPath = this.downloader.findExistingVideoFile(article.title, videoDir);
                if (dupPath) {
                    this.logger.info('VIDEO_DUPLICATE_FOUND', { newsId, dupPath });
                    await MysqlStore.saveLocalPath(newsId, dupPath);
                    return { saved: true, alreadyExists: false, extractFailed: false, hadVideo: true, videoDownloaded: true, videoFailed: false };
                }

                const localPath = await this.downloader.downloadVideo(newsId, article.title, article.video_url, videoDir, article.source_url);

                if (localPath) {
                    await MysqlStore.saveLocalPath(newsId, localPath);
                    return { saved: true, alreadyExists: false, extractFailed: false, hadVideo: true, videoDownloaded: true, videoFailed: false };
                } else {
                    await MysqlStore.markVideoFailed(newsId);
                    return { saved: true, alreadyExists: false, extractFailed: false, hadVideo: true, videoDownloaded: false, videoFailed: true };
                }
            }

            await MysqlStore.markDownloaded(newsId);
            return { saved: true, alreadyExists: false, extractFailed: false, hadVideo: false, videoDownloaded: false, videoFailed: false };
        } catch (e: any) {
            this.logger.error('PROCESS_ARTICLE_ERROR', { url, err: e.message });
            return { saved: false, alreadyExists: false, extractFailed: false, hadVideo: false, videoDownloaded: false, videoFailed: false };
        }
    }

    private async scanSeed(seedUrl: string, videoDir: string, limit: number, currentTotal: number, maxTotal: number): Promise<CrawlSummary> {
        const summary = this.createSummary(seedUrl, limit);
        const startedAt = Date.now();
        try {
            const source = detectSource(seedUrl);
            const categorySlug = extractCategorySlug(seedUrl);
            const categoryId = await MysqlStore.getOrCreateCategory(source, categorySlug, seedUrl);
            this.logger.info('CATEGORY_RESOLVED', { seedUrl, categoryId, categorySlug });

            const articleUrls = await this.extractor.getArticleUrls(seedUrl, limit);
            summary.foundCount = articleUrls.length;

            if (articleUrls.length === 0) {
                this.logger.warn('SEED_CRAWL_EMPTY', { seedUrl, source });
                return summary;
            }

            for (const articleUrl of articleUrls) {
                const result = await this.processSingleArticle(articleUrl, videoDir, categoryId);
                summary.scannedCount++;

                if (result.saved) {
                    summary.savedCount++;
                    result.hadVideo ? summary.videoAttemptedCount++ : summary.noVideoCount++;
                    if (result.videoDownloaded) summary.videoDownloadedCount++;
                    if (result.videoFailed) summary.videoFailedCount++;
                    if (currentTotal + summary.savedCount >= maxTotal) break;
                }
                if (result.alreadyExists) summary.existingCount++;
                if (result.extractFailed) summary.extractFailedCount++;
            }

            return summary;
        } catch (e: any) {
            this.logger.error('SCAN_SEED_ERROR', { seedUrl, err: e.message });
            return summary;
        } finally {
            summary.durationMs = Date.now() - startedAt;
        }
    }

    public async crawlNews(limit = 20, seedUrl?: string): Promise<CrawlSummary> {
        try {
            const videoDir = path.resolve(ENV.VIDEO_DOWNLOAD_DIR);
            this.downloader.ensureDir(videoDir);

            const seedUrls = seedUrl ? [seedUrl] : (ENV.NEWS_SEED_URLS || []);
            if (seedUrls.length === 0) {
                this.logger.warn('NO_SEED_URLS_CONFIGURED');
                return this.createSummary(seedUrl || 'all', limit);
            }

            const perSeedLimit = seedUrl ? limit : Math.max(5, Math.ceil(limit / seedUrls.length));
            let totalSaved = 0;
            const summary = this.createSummary(seedUrl || 'all', limit);
            if (!seedUrl) summary.source = 'all';

            for (const seed of seedUrls) {
                const seedSummary = await this.scanSeed(seed, videoDir, perSeedLimit, totalSaved, limit);
                this.mergeSummary(summary, seedSummary);
                totalSaved += seedSummary.savedCount;
                if (totalSaved >= limit) break;
            }

            return summary;
        } catch (e: any) {
            this.logger.error('CRAWL_CRITICAL_ERROR', { err: e.message });
            return this.createSummary(seedUrl || 'all', limit);
        } finally {
            await this.extractor.close();
        }
    }
}
