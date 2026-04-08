/**
 * - Mọi trang báo đều dùng DEFAULT_CONFIG nếu không có config riêng.
 * - Để thêm nguồn mới: CHỈ cần thêm URL vào NEWS_SEED_URLS trong .env, KHÔNG cần sửa code.
 * - Chỉ cần thêm vào SOURCE_CONFIGS nếu trang đó có cấu trúc đặc biệt khác với mặc định.
 */

export interface SourceConfig {
    articleLinkSelector: string;
    articleLinkFilter: (href: string, origin: string) => boolean;
    titleSelectors: string[];
    descSelectors: string[];
    authorSelectors: string[];
    imageSelectors: string[];
    videoInterceptHosts: string[];
}

/**
 * Config mặc định — dùng chung cho mọi trang báo.
 * Dùng các thẻ HTML/meta chuẩn nên hoạt động với hầu hết trang tin tức Việt Nam.
 */
const DEFAULT_CONFIG: SourceConfig = {
    articleLinkSelector: 'a[href]',
    articleLinkFilter: (href, origin) => {
        try {
            const hrefUrl = new URL(href);
            const originUrl = new URL(origin);
            const hrefHost = hrefUrl.hostname.replace(/^www\./, '');
            const originHost = originUrl.hostname.replace(/^www\./, '');

            // 1. Phải cùng domain (bỏ qua www.)
            if (hrefHost !== originHost) return false;

            // 2. Phải là file .html hoặc .htm
            if (!href.includes('.html') && !href.includes('.htm')) return false;

            // 3. Loại bỏ các đường dẫn không phải bài viết (tag, search, author, topic, ...)
            const blacklist = ['/tag/', '/topic/', '/event/', '/search/', '/category/', '/tac-gia/', '/author/', '/chu-de/', '/su-kien/', '/video/', '/podcast/'];
            if (blacklist.some(b => href.includes(b))) return false;

            // 4. Regex nhận diện ID bài viết (thường là dãy số >= 5 chữ số có dấu gạch ngang phía trước)
            // Ví dụ: abc-12345.html
            return /\-\d{5,}\.html?(\?|$)/i.test(href);
        } catch {
            return false;
        }
    },
    titleSelectors: ['meta[property="og:title"]', 'title', 'h1'],
    descSelectors: ['meta[property="og:description"]', 'meta[name="description"]'],
    authorSelectors: ['meta[name="author"]', '.author-name', '.author', '[class*="author"]'],
    // og:image là chuẩn OpenGraph, gần như mọi trang báo đều có
    imageSelectors: ['meta[property="og:image"]', 'article img', 'figure img'],
    // Để trống → crawler tự intercept mọi video playable (.m3u8, .mp4) từ cùng domain
    videoInterceptHosts: [],
};

/**
 * Override config cho các trang có cấu trúc đặc biệt.
 * Trang không có ở đây sẽ tự động dùng DEFAULT_CONFIG.
 */
const SOURCE_CONFIGS: Record<string, SourceConfig> = {
    zingnews: {
        ...DEFAULT_CONFIG,
        // zingnews có thể link qua znews.vn nên cần filter rộng hơn
        articleLinkFilter: (href, origin) => {
            const isMatch = (href.startsWith(origin) ||
                href.startsWith(origin.replace('zingnews.vn', 'znews.vn')) ||
                href.startsWith('https://znews.vn/'));
            
            if (!isMatch) return false;
            if (!href.includes('.html')) return false;

            const blacklist = ['/tag/', '/chu-de/', '/video/', '/podcast/', '/chuyen-muc/'];
            if (blacklist.some(b => href.includes(b))) return false;

            return /\-\d{5,}\.html?(\?|$)/i.test(href) || /post\d+\.html?(\?|$)/i.test(href);
        },
        videoInterceptHosts: ['video.zingnews.vn', 'cdn.zingnews.vn', 'streaming.znews.vn', 'video.znews.vn'],
    },
};

/** Lấy SourceConfig cho URL. Fallback về DEFAULT_CONFIG nếu không có config riêng. */
export function getSourceConfig(source: string): SourceConfig {
    try {
        return SOURCE_CONFIGS[source] ?? DEFAULT_CONFIG;
    } catch {
        return DEFAULT_CONFIG;
    }
}

/** Nhận diện nguồn tin từ URL để tìm override config trong SOURCE_CONFIGS */
export function detectSource(url: string): string {
    try {
        if (url.includes('zingnews.vn') || url.includes('znews.vn')) return 'zingnews';
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return 'unknown';
    }
}

/** Lấy slug từ path URL làm tên category tạm. VD: /the-gioi → "the-gioi", homepage → "home" */
export function extractCategorySlug(url: string): string {
    try {
        const pathname = new URL(url).pathname;
        const slug = pathname.replace(/^\/|\/$/g, '').replace(/\.html?$/, '').split('/').filter(Boolean).pop();
        return slug || 'home';
    } catch {
        return 'home';
    }
}
