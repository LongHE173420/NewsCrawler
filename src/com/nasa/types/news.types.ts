export interface CrawlSummary {
    seedUrl: string;
    source: string;
    limit: number;
    foundCount: number;
    scannedCount: number;
    savedCount: number;
    existingCount: number;
    extractFailedCount: number;
    videoAttemptedCount: number;
    videoDownloadedCount: number;
    videoFailedCount: number;
    noVideoCount: number;
    durationMs: number;
}

export interface NewsArticle {
    source_url: string;
    source: string;
    title: string;
    description: string;
    image_url: string;
    video_url: string;
    author: string;
}

export interface ProcessArticleResult {
    saved: boolean;
    alreadyExists: boolean;
    extractFailed: boolean;
    hadVideo: boolean;
    videoDownloaded: boolean;
    videoFailed: boolean;
}
