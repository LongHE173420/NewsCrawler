import mysql from 'mysql2/promise';
import { ENV } from '../config/env';

export class MysqlStore {
    private static pool: mysql.Pool | null = null;

    private static getPool(): mysql.Pool {
        if (!this.pool) {
            this.pool = mysql.createPool({
                host: ENV.DB_HOST,
                user: ENV.DB_USER,
                password: ENV.DB_PASS,
                database: ENV.DB_NAME,
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0,
                connectTimeout: 10000,
            });
        }
        return this.pool;
    }

    static async initCrawlTables() {
        try {
            // Kết nối tạm (không dùng DB) để tạo DB nếu chưa có
            const tempConn = await mysql.createConnection({
                host: ENV.DB_HOST,
                user: ENV.DB_USER,
                password: ENV.DB_PASS,
            });
            await tempConn.execute(`CREATE DATABASE IF NOT EXISTS \`${ENV.DB_NAME}\``);
            await tempConn.end();

            const pool = this.getPool();
            await pool.execute(`
                CREATE TABLE IF NOT EXISTS crawled_news (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    source VARCHAR(50),
                    source_url VARCHAR(255) UNIQUE,
                    category VARCHAR(100),
                    title TEXT,
                    description TEXT,
                    image_url TEXT,
                    video_url TEXT,
                    local_path VARCHAR(255),
                    downloaded TINYINT DEFAULT 0,
                    author VARCHAR(100),
                    post_count INT DEFAULT 0,
                    max_posts INT DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            const ensureColumn = async (columnName: string, sqlType: string) => {
                const [rows] = await pool.execute<mysql.RowDataPacket[]>(
                    `SELECT COLUMN_NAME
                     FROM INFORMATION_SCHEMA.COLUMNS
                     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'crawled_news' AND COLUMN_NAME = ?`,
                    [ENV.DB_NAME, columnName]
                );
                if (!rows.length) {
                    await pool.execute(`ALTER TABLE crawled_news ADD COLUMN ${columnName} ${sqlType}`);
                }
            };

            const dropColumn = async (columnName: string) => {
                const [rows] = await pool.execute<mysql.RowDataPacket[]>(
                    `SELECT COLUMN_NAME
                     FROM INFORMATION_SCHEMA.COLUMNS
                     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'crawled_news' AND COLUMN_NAME = ?`,
                    [ENV.DB_NAME, columnName]
                );
                if (rows.length) {
                    await pool.execute(`ALTER TABLE crawled_news DROP COLUMN ${columnName}`);
                    console.info(`[DB] Dropped column crawled_news.${columnName}`);
                }
            };

            await ensureColumn('description', 'TEXT');
            await ensureColumn('category_id', 'INT DEFAULT NULL');
            await pool.execute(`
                CREATE TABLE IF NOT EXISTS news_categories (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    source VARCHAR(50) NOT NULL COMMENT 'Nguồn tin: vnexpress, dantri, tuoitre, thanhnien, zingnews',
                    name VARCHAR(100) NOT NULL COMMENT 'Tên category hiển thị',
                    url VARCHAR(255) NOT NULL UNIQUE COMMENT 'URL trang category',
                    is_active TINYINT DEFAULT 1 COMMENT '1=đang dùng, 0=tắt',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
        } catch (e: any) {
            console.error("[DB] initCrawlTables failed:", e.message);
            throw e;
        }
    }

    static async saveCrawledNews(data: {
        source: string;
        source_url: string;
        category_id: number | null;
        title: string;
        description: string;
        image_url: string;
        video_url: string;
        author: string;
    }): Promise<number | null> {
        const pool = this.getPool();
        try {
            const [result]: any = await pool.execute(
                `INSERT IGNORE INTO crawled_news
                 (source, source_url, category_id, title, description, image_url, video_url, author, max_posts)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    data.source,
                    data.source_url,
                    data.category_id,
                    data.title,
                    data.description,
                    data.image_url,
                    data.video_url,
                    data.author,
                    ENV.MAX_POSTS_PER_NEWS,
                ]
            );
            const insertId: number = result.insertId;
            if (insertId === 0) return null; // Đã có trong DB
            return insertId;
        } catch (e: any) {
            console.error("[DB] saveCrawledNews failed:", e.message);
            return null;
        }
    }

    static async saveLocalPath(newsId: number, localPath: string) {
        const pool = this.getPool();
        try {
            await pool.execute(
                `UPDATE crawled_news SET local_path = ?, downloaded = 1 WHERE id = ?`,
                [localPath, newsId]
            );
        } catch (e: any) {
            console.error("[DB] saveLocalPath failed:", e.message);
        }
    }

    static async markVideoFailed(newsId: number) {
        const pool = this.getPool();
        try {
            await pool.execute(
                `UPDATE crawled_news SET downloaded = 2 WHERE id = ?`,
                [newsId]
            );
        } catch (e: any) {
            console.error("[DB] markVideoFailed failed:", e.message);
        }
    }

    static async getCategoryUrls(): Promise<{ source: string; name: string; url: string }[]> {
        const pool = this.getPool();
        try {
            const [rows] = await pool.execute<mysql.RowDataPacket[]>(
                `SELECT source, name, url FROM news_categories WHERE is_active = 1 ORDER BY source, id`
            );
            return rows as { source: string; name: string; url: string }[];
        } catch (e: any) {
            console.error('[DB] getCategoryUrls failed:', e.message);
            return [];
        }
    }

    /**
     * Tìm hoặc tạo mới bản ghi trong news_categories, trả về id.
     * Dùng khi bắt đầu crawl một category URL để liên kết crawled_news.category_id.
     */
    static async getOrCreateCategory(source: string, name: string, url: string): Promise<number | null> {
        const pool = this.getPool();
        try {
            // Thử tìm bằng URL trước
            const [existing] = await pool.execute<mysql.RowDataPacket[]>(
                `SELECT id FROM news_categories WHERE url = ?`,
                [url]
            );
            if (existing.length > 0) return (existing[0] as any).id as number;

            // Chưa có → insert mới
            const [result]: any = await pool.execute(
                `INSERT IGNORE INTO news_categories (source, name, url) VALUES (?, ?, ?)`,
                [source, name, url]
            );
            if (result.insertId) return result.insertId as number;

            // Trường hợp race condition: query lại
            const [retry] = await pool.execute<mysql.RowDataPacket[]>(
                `SELECT id FROM news_categories WHERE url = ?`,
                [url]
            );
            return retry[0] ? (retry[0] as any).id as number : null;
        } catch (e: any) {
            console.error('[DB] getOrCreateCategory failed:', e.message);
            return null;
        }
    }

    static async cleanupFullyPostedNews(): Promise<number> {
        const pool = this.getPool();
        try {
            const [rows]: any = await pool.execute(
                `SELECT id, local_path FROM crawled_news
                 WHERE post_count >= max_posts AND local_path IS NOT NULL AND downloaded = 1`
            );
            let cleaned = 0;
            const fs = await import('fs');
            for (const row of rows as { id: number; local_path: string }[]) {
                if (fs.existsSync(row.local_path)) {
                    fs.unlinkSync(row.local_path);
                    cleaned++;
                }
                await pool.execute(
                    `UPDATE crawled_news SET local_path = NULL, downloaded = 0 WHERE id = ?`,
                    [row.id]
                );
            }
            return cleaned;
        } catch (e: any) {
            console.error("[DB] cleanupFullyPostedNews failed:", e.message);
            return 0;
        }
    }
}
