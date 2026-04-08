import puppeteer, { Browser, Page } from 'puppeteer';
import { Log } from '../utils/log';
import { getSourceConfig, detectSource } from '../config/sources';
import { NewsArticle } from '../types/news.types';
import { canonicalizeUrl, cleanText, isPlayableVideoUrl } from '../utils/crawl-utils';

type AppLogger = ReturnType<typeof Log.getLogger>;

export class ArticleExtractorService {
    private browser: Browser | null = null;

    constructor(private logger: AppLogger) { }

    async close() {
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
            }
        } catch (e: any) {
            this.logger.error('BROWSER_CLOSE_ERROR', { err: e.message });
        }
    }

    private async getBrowser(): Promise<Browser> {
        try {
            if (!this.browser || !this.browser.connected) {
                this.browser = await puppeteer.launch({
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                });
            }
            return this.browser;
        } catch (e: any) {
            this.logger.error('BROWSER_LAUNCH_ERROR', { err: e.message });
            throw e;
        }
    }

    async getArticleUrls(seedUrl: string, limit: number): Promise<string[]> {
        let page: Page | null = null;
        try {
            const source = detectSource(seedUrl);
            const config = getSourceConfig(source);
            const origin = new URL(seedUrl).origin;
            const maxCandidates = Math.max(limit * 50, 300);

            const browser = await this.getBrowser();
            page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

            this.logger.info('SEED_SCAN_START', { seedUrl, source });
            await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await new Promise(resolve => setTimeout(resolve, 1500));

            const urls: string[] = await page.evaluate((selector, candidateLimit) => {
                const links = Array.from(document.querySelectorAll(selector));
                const found: string[] = [];
                for (const link of links) {
                    const href = (link as HTMLAnchorElement).href;
                    if (href && !found.includes(href)) {
                        found.push(href);
                        if (found.length >= candidateLimit) break;
                    }
                }
                return found;
            }, config.articleLinkSelector, maxCandidates);

            const filtered = urls
                .map(href => canonicalizeUrl(href))
                .filter(href => config.articleLinkFilter(href, `${origin}/`))
                .filter((href, index, list) => list.indexOf(href) === index)
                .slice(0, limit);

            if (filtered.length === 0) {
                this.logger.warn('SEED_SCAN_FILTERED_ALL', {
                    seedUrl, source,
                    rawFound: urls.length,
                    sampleUrls: urls.slice(0, 5),
                    filterLogic: 'Check sources.ts DEFAULT_CONFIG.articleLinkFilter'
                });
            }

            this.logger.info('SEED_SCAN_DONE', { seedUrl, source, found: filtered.length });
            return filtered;
        } catch (e: any) {
            this.logger.error('SEED_SCAN_ERROR', { seedUrl, err: e.message });
            return [];
        } finally {
            if (page) await page.close().catch(() => undefined);
        }
    }

    async extractArticle(url: string): Promise<NewsArticle | null> {
        let page: Page | null = null;
        try {
            const source = detectSource(url);
            const config = getSourceConfig(source);

            const browser = await this.getBrowser();
            page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

            let interceptedVideoUrl = '';
            const videoPromise = new Promise<string>((resolve) => {
                let found = false;
                const timeout = setTimeout(() => { if (!found) resolve(''); }, 8000);

                page!.on('response', (response) => {
                    if (found) return;
                    const responseUrl = response.url();
                    if (
                        !responseUrl.startsWith('blob:') &&
                        !responseUrl.startsWith('data:') &&
                        isPlayableVideoUrl(responseUrl) &&
                        !responseUrl.includes('/ads/') &&
                        (
                            config.videoInterceptHosts.length === 0
                                ? true
                                : config.videoInterceptHosts.some(host => responseUrl.includes(host))
                        )
                    ) {
                        found = true;
                        clearTimeout(timeout);
                        this.logger.debug('VIDEO_URL_INTERCEPTED', { source, url: responseUrl });
                        resolve(responseUrl);
                    }
                });
            });

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            interceptedVideoUrl = await videoPromise;

            const data: Omit<NewsArticle, 'source'> = await page.evaluate((sourceUrl, cfg) => {
                const firstText = (selectors: string[]) => {
                    for (const selector of selectors) {
                        const element = document.querySelector(selector);
                        if (element) {
                            const value = (element as HTMLMetaElement).content || element.textContent;
                            if (value?.trim()) return value.trim();
                        }
                    }
                    return '';
                };

                const firstSrc = (selectors: string[]) => {
                    for (const selector of selectors) {
                        const element = document.querySelector(selector);
                        if (!element) continue;
                        const src = (element as HTMLImageElement).src;
                        if (src && src.startsWith('http')) return src;
                        const content = (element as HTMLMetaElement).content;
                        if (content && content.startsWith('http')) return content;
                    }
                    return '';
                };

                const videoEl = document.querySelector('video') as HTMLVideoElement | null;

                return {
                    source_url: sourceUrl,
                    title: firstText(cfg.titleSelectors),
                    description: firstText(cfg.descSelectors),
                    image_url: firstSrc(cfg.imageSelectors),
                    video_url: videoEl?.src || '',
                    author: firstText(cfg.authorSelectors),
                };
            }, url, config as any);

            data.source_url = canonicalizeUrl(data.source_url);
            data.title = cleanText(data.title);
            data.description = cleanText(data.description);
            data.author = cleanText(data.author);

            if ((!data.video_url || !isPlayableVideoUrl(data.video_url)) && interceptedVideoUrl) {
                data.video_url = interceptedVideoUrl;
            }

            if (data.video_url && !isPlayableVideoUrl(data.video_url)) {
                data.video_url = '';
            }

            return data.title ? { ...data, source } : null;
        } catch (e: any) {
            this.logger.error('EXTRACT_ARTICLE_ERROR', { url, err: e.message });
            return null;
        } finally {
            if (page) await page.close().catch(() => undefined);
        }
    }
}
