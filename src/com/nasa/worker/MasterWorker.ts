import { ENV } from '../config/env';
import { Log } from '../utils/log';
import { CrawlSummary } from '../service/NewsCrawlService';
import { CrawlerWorker } from './CrawlerWorker';

export class MasterWorker {
    private logger = Log.getLogger('MasterWorker');
    private workers: CrawlerWorker[] = [];

    public async start() {
        try {
            this.logger.info('MASTER_WORKER_STARTING', {
                enabled: ENV.CRAWL_NEWS_ENABLED,
                seedsCount: ENV.NEWS_SEED_URLS.length,
            });

            if (!ENV.CRAWL_NEWS_ENABLED) {
                this.logger.warn('CRAWL_DISABLED_BY_CONFIG');
                return;
            }

            const seeds = ENV.NEWS_SEED_URLS || [];
            const perWorkerLimit = Math.max(1, Math.ceil(ENV.CRAWL_LIMIT / seeds.length));

            this.logger.info('MASTER_WORKERS_PLAN', {
                totalSeeds: seeds.length,
                perWorkerLimit,
            });

            const initialRuns: Array<Promise<CrawlSummary | null>> = [];
            for (const seed of seeds) {
                initialRuns.push(this.spawnWorker(seed, perWorkerLimit));
            }

            void Promise.all(initialRuns)
                .then((summaries) => {
                    const ready = summaries.filter((item): item is CrawlSummary => Boolean(item));
                    if (!ready.length) return;

                    const total = ready.reduce((acc, item) => {
                        acc.foundCount += item.foundCount;
                        acc.savedCount += item.savedCount;
                        acc.existingCount += item.existingCount;
                        acc.videoAttemptedCount += item.videoAttemptedCount;
                        acc.videoDownloadedCount += item.videoDownloadedCount;
                        acc.videoFailedCount += item.videoFailedCount;
                        acc.noVideoCount += item.noVideoCount;
                        acc.durationMs += item.durationMs;
                        return acc;
                    }, {
                        foundCount: 0,
                        savedCount: 0,
                        existingCount: 0,
                        videoAttemptedCount: 0,
                        videoDownloadedCount: 0,
                        videoFailedCount: 0,
                        noVideoCount: 0,
                        durationMs: 0,
                    });

                    this.logger.info('MASTER_SUMMARY', {
                        workers: ready.length,
                        foundCount: total.foundCount,
                        savedCount: total.savedCount,
                        existingCount: total.existingCount,
                        videoAttemptedCount: total.videoAttemptedCount,
                        videoDownloadedCount: total.videoDownloadedCount,
                        videoFailedCount: total.videoFailedCount,
                        noVideoCount: total.noVideoCount,
                        durationMs: total.durationMs,
                    });
                })
                .catch((err: any) => {
                    this.logger.error('MASTER_SUMMARY_ERROR', { err: err.message });
                });
        } catch (e: any) {
            this.logger.error('MASTER_WORKER_ERROR', { err: e.message });
        }
    }

    private spawnWorker(seedUrl: string, perWorkerLimit: number): Promise<CrawlSummary | null> {
        try {
            const worker = new CrawlerWorker(seedUrl, perWorkerLimit);
            this.workers.push(worker);

            const runPromise = worker.start().catch((err: any) => {
                this.logger.error('WORKER_ERROR', { seedUrl, err: err.message });
                return null;
            });

            this.logger.info('SPAWNED_WORKER_FOR_SEED', { seedUrl, perWorkerLimit });
            return runPromise;
        } catch (e: any) {
            this.logger.error('SPAWN_WORKER_ERROR', { seedUrl, err: e.message });
            return Promise.resolve(null);
        }
    }
}
