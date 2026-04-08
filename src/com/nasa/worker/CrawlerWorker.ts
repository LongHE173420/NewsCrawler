import { CrawlSummary, NewsCrawlService } from '../service/NewsCrawlService';
import { MysqlStore } from '../data/MysqlStore';
import { ENV } from '../config/env';
import { Log } from '../utils/log';

export class CrawlerWorker {
    private logger: ReturnType<typeof Log.getLogger>;
    private crawlService: NewsCrawlService;
    private crawlRunning = false;

    constructor(private seedUrl: string, private perWorkerLimit: number) {
        const loggerName = `Worker-${new URL(seedUrl).hostname.replace(/\./g, '-')}`;
        this.logger = Log.getLogger(loggerName);
        try {
            this.crawlService = new NewsCrawlService(Log.getLogger('NewsCrawl'));
        } catch (e: any) {
            this.logger.error('CONSTRUCTOR_FAIL', { err: e.message });
            this.crawlService = null!;
        }
    }

    private async runCrawl(): Promise<CrawlSummary | null> {
        if (this.crawlRunning) return null;
        this.crawlRunning = true;
        try {
            this.logger.info('CRAWL_CYCLE_START', { seedUrl: this.seedUrl });

            const cleaned = await MysqlStore.cleanupFullyPostedNews();
            if (cleaned > 0) {
                this.logger.info('CLEANUP_BEFORE_CRAWL', { deletedFiles: cleaned });
            }

            if (ENV.CRAWL_NEWS_ENABLED) {
                const summary = await this.crawlService.crawlNews(this.perWorkerLimit, this.seedUrl);
                this.logger.info('WORKER_SUMMARY', {
                    seedUrl: this.seedUrl,
                    source: summary.source,
                    foundCount: summary.foundCount,
                    scannedCount: summary.scannedCount,
                    savedCount: summary.savedCount,
                    existingCount: summary.existingCount,
                    extractFailedCount: summary.extractFailedCount,
                    videoAttemptedCount: summary.videoAttemptedCount,
                    videoDownloadedCount: summary.videoDownloadedCount,
                    videoFailedCount: summary.videoFailedCount,
                    noVideoCount: summary.noVideoCount,
                    durationMs: summary.durationMs,
                });
                return summary;
            } else {
                this.logger.warn('CRAWL_DISABLED_BY_CONFIG');
            }
        } catch (e: any) {
            this.logger.error('CRAWL_ERROR', { err: e.message });
        } finally {
            this.crawlRunning = false;
        }
        return null;
    }

    private async runCleanup() {
        try {
            const deleted = await MysqlStore.cleanupFullyPostedNews();
            if (deleted > 0) {
                this.logger.info('CLEANUP_SUCCESS', { deletedFiles: deleted });
            }
        } catch (e: any) {
            this.logger.error('CLEANUP_ERROR', { err: e.message });
        }
    }

    public async start(): Promise<CrawlSummary | null> {
        try {

            if (!ENV.CRAWL_NEWS_ENABLED) {
                this.logger.warn('CRAWL_DISABLED_BY_CONFIG');
                return null;
            }

            const crawlInterval = ENV.CRAWL_INTERVAL_MS || 60 * 60 * 1000;
            const cleanupInterval = 60 * 60 * 1000;

            this.logger.info('CRAWLER_WORKER_STARTED', {
                crawlInterval: crawlInterval / 1000,
                cleanupInterval: cleanupInterval / 1000,
                seedUrl: this.seedUrl || 'all',
            });

            await this.runCleanup();
            const firstRun = this.runCrawl();

            setInterval(() => this.runCrawl(), crawlInterval);
            setInterval(() => this.runCleanup(), cleanupInterval);
            return await firstRun;
        } catch (e: any) {
            this.logger.error('CRAWLER_WORKER_START_FAIL', { err: e.message });
        }
        return null;
    }
}
