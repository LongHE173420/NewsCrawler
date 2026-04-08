export function canonicalizeUrl(rawUrl: string): string {
    try {
        const url = new URL(rawUrl);
        url.hash = '';
        const removableParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
        for (const key of removableParams) {
            url.searchParams.delete(key);
        }
        return url.toString();
    } catch {
        return rawUrl.split('#')[0];
    }
}

export function cleanText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

export function slugifyFileName(input: string): string {
    const normalized = input
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\u0111/g, 'd')
        .replace(/\u0110/g, 'D');

    return normalized
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120) || 'news';
}

export function isPlayableVideoUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes('.m3u8') || lower.includes('.mp4');
}
