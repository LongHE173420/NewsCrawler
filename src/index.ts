import { MasterWorker } from './com/nasa/worker/MasterWorker';
import { MysqlStore } from './com/nasa/data/MysqlStore';
import { Log, getTodayLogPath } from './com/nasa/utils/log';
import { ENV } from './com/nasa/config/env';

async function main() {
    try {
        const { filePath } = getTodayLogPath();
        Log.init({
            appName: 'NewsCrawlerMaster',
            level: (ENV.LOG_LEVEL as any) || 'info',
            filePath,
        });

        const logger = Log.getLogger('Bootstrap');

        logger.info('BOOTSTRAP_READY', { dbName: ENV.DB_NAME, logFile: filePath });

        const master = new MasterWorker();
        await master.start();

        const runCleanup = async () => {
            try {
                const deleted = await MysqlStore.cleanupFullyPostedNews();
                if (deleted > 0) {
                    logger.info('MASTER_CLEANUP_SUCCESS', { deletedFiles: deleted });
                }
            } catch (e: any) {
                logger.error('MASTER_CLEANUP_ERROR', { err: e.message });
            }
        };

        const cleanupInterval = 60 * 60 * 1000;
        setInterval(runCleanup, cleanupInterval);
    } catch (err: any) {
        console.error('Failed to start News Crawler:', err.message);
        process.exit(1);
    }
}

main();
