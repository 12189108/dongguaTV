require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'db.json');
const TEMPLATE_FILE = path.join(__dirname, 'db.template.json');

// 访问密码配置
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const PASSWORD_HASH = ACCESS_PASSWORD ? crypto.createHash('sha256').update(ACCESS_PASSWORD).digest('hex') : '';

// 远程配置URL
const REMOTE_DB_URL = process.env.REMOTE_DB_URL || '';

// 远程配置缓存
let remoteDbCache = null;
let remoteDbLastFetch = 0;
const REMOTE_DB_CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 缓存配置
const CACHE_TYPE = process.env.CACHE_TYPE || 'json'; // json, sqlite, memory, none
const SEARCH_CACHE_JSON = path.join(__dirname, 'cache_search.json');
const DETAIL_CACHE_JSON = path.join(__dirname, 'cache_detail.json');
const CACHE_DB_FILE = path.join(__dirname, 'cache.db');

console.log(`[System] Cache Type: ${CACHE_TYPE}`);

// 初始化数据库文件
if (!fs.existsSync(DATA_FILE)) {
    if (fs.existsSync(TEMPLATE_FILE)) {
        fs.copyFileSync(TEMPLATE_FILE, DATA_FILE);
        console.log('[Init] 已从模板创建 db.json');
    } else {
        const initialData = { sites: [] };
        fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
        console.log('[Init] 已创建默认 db.json');
    }
}

// ========== 缓存抽象层 ==========
class CacheManager {
    constructor(type) {
        this.type = type;
        this.searchCache = {};
        this.detailCache = {};
        this.init();
    }

    init() {
        if (this.type === 'json') {
            if (fs.existsSync(SEARCH_CACHE_JSON)) {
                try { this.searchCache = JSON.parse(fs.readFileSync(SEARCH_CACHE_JSON)); } catch (e) { }
            }
            if (fs.existsSync(DETAIL_CACHE_JSON)) {
                try { this.detailCache = JSON.parse(fs.readFileSync(DETAIL_CACHE_JSON)); } catch (e) { }
            }
        } else if (this.type === 'sqlite') {
            // (SQLite implementation simplified for brevity)
        }
    }

    get(category, key) {
        if (this.type === 'memory') {
            return category === 'search' ? this.searchCache[key] : this.detailCache[key];
        } else if (this.type === 'json') {
            const data = category === 'search' ? this.searchCache[key] : this.detailCache[key];
            if (data && data.expire > Date.now()) return data.value;
            return null;
        }
        return null;
    }

    set(category, key, value, ttlSeconds = 600) {
        const expire = Date.now() + ttlSeconds * 1000;
        const item = { value, expire };
        if (this.type === 'memory' || this.type === 'json') {
            if (category === 'search') this.searchCache[key] = item;
            else this.detailCache[key] = item;

            if (this.type === 'json') {
                this.saveDisk(); // Simple impl: save on every set (optimize for production!)
            }
        }
    }

    saveDisk() {
        if (this.type === 'json') {
            fs.writeFileSync(SEARCH_CACHE_JSON, JSON.stringify(this.searchCache));
            fs.writeFileSync(DETAIL_CACHE_JSON, JSON.stringify(this.detailCache));
        }
    }
}

const cacheManager = new CacheManager(CACHE_TYPE);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// ========== 路由定义 ==========

const IS_VERCEL = !!process.env.VERCEL;

app.get('/api/config', (req, res) => {
    res.json({
        tmdb_api_key: process.env.TMDB_API_KEY,
        tmdb_proxy_url: process.env.TMDB_PROXY_URL,
        // Vercel 环境下禁用本地图片缓存，防止写入报错
        enable_local_image_cache: !IS_VERCEL
    });
});

// TMDB API 代理端点
app.post('/api/tmdb', async (req, res) => {
    const { path, params } = req.body;

    if (!path) {
        return res.status(400).json({ error: 'Missing path parameter' });
    }

    if (!process.env.TMDB_API_KEY) {
        console.error('[TMDB Proxy] TMDB_API_KEY not configured');
        return res.status(500).json({ error: 'TMDB API not configured' });
    }

    try {
        // 构建完整的 TMDB URL
        const baseUrl = process.env.TMDB_PROXY_URL
            ? `${process.env.TMDB_PROXY_URL}/api/3`
            : 'https://api.themoviedb.org/3';

        const queryParams = new URLSearchParams({
            api_key: process.env.TMDB_API_KEY,
            ...params
        });

        const tmdbUrl = `${baseUrl}${path}?${queryParams}`;
        console.log(`[TMDB Proxy] ${path}`);

        const response = await axios.get(tmdbUrl, {
            timeout: 10000
        });

        res.json(response.data);
    } catch (error) {
        console.error(`[TMDB Proxy Error] ${path}:`, error.message);
        res.status(error.response?.status || 500).json({
            error: 'TMDB API request failed',
            message: error.message
        });
    }
});

// 1. 获取站点列表
app.get('/api/sites', async (req, res) => {
    let sitesData = null;

    // 尝试从远程加载
    if (REMOTE_DB_URL) {
        const now = Date.now();
        if (remoteDbCache && now - remoteDbLastFetch < REMOTE_DB_CACHE_TTL) {
            sitesData = remoteDbCache;
        } else {
            try {
                const response = await axios.get(REMOTE_DB_URL, { timeout: 5000 });
                if (response.data && Array.isArray(response.data.sites)) {
                    sitesData = response.data;
                    remoteDbCache = sitesData;
                    remoteDbLastFetch = now;
                    console.log('[Remote] Config loaded successfully');
                }
            } catch (err) {
                console.error('[Remote] Failed to load config:', err.message);
            }
        }
    }

    // 回退到本地
    if (!sitesData) {
        sitesData = JSON.parse(fs.readFileSync(DATA_FILE));
    }

    res.json(sitesData);
});

// 2. 流式搜索 API (Server-Sent Events)
app.get('/api/search', async (req, res) => {
    const keyword = req.query.wd;
    const stream = req.query.stream === 'true';

    if (!keyword) {
        return res.status(400).json({ error: 'Missing keyword parameter' });
    }

    if (!stream) {
        return res.status(400).json({ error: 'Use POST method for non-stream search' });
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    console.log(`[Stream Search] keyword: ${keyword}`);

    const sites = getDB().sites;
    let completedCount = 0;

    // 并发搜索所有站点
    sites.map(async (site) => {
        try {
            const response = await axios.get(site.api, {
                params: { ac: 'detail', wd: keyword },
                timeout: 8000
            });

            const data = response.data;
            if (data.list && data.list.length > 0) {
                const cleanedList = data.list.map(item => ({
                    vod_id: item.vod_id,
                    vod_name: item.vod_name,
                    vod_pic: item.vod_pic,
                    vod_remarks: item.vod_remarks,
                    vod_year: item.vod_year,
                    vod_play_url: item.vod_play_url,
                    vod_content: item.vod_content,
                    type_name: item.type_name,
                    site_key: site.key,
                    site_name: site.name
                }));

                res.write(`data: ${JSON.stringify(cleanedList)}\n\n`);
                console.log(`[Stream Search] ${site.name}: found ${cleanedList.length} results`);
            }
        } catch (error) {
            console.error(`[Stream Search Error] ${site.name}:`, error.message);
        } finally {
            completedCount++;
            if (completedCount === sites.length) {
                res.write('event: done\n');
                res.write('data: {}\n\n');
                res.end();
            }
        }
    });

    req.on('close', () => {
        console.log('[Stream Search] Client disconnected');
    });
});

// 3. 详情 API (带缓存)
app.get('/api/detail', async (req, res) => {
    const id = req.query.id;
    const siteKey = req.query.site_key;

    if (!id || !siteKey) {
        return res.status(400).json({ error: 'Missing id or site_key parameter' });
    }

    const sites = getDB().sites;
    const site = sites.find(s => s.key === siteKey);

    if (!site) return res.status(404).json({ error: 'Site not found' });

    const cacheKey = `${siteKey}_detail_${id}`;
    const cached = cacheManager.get('detail', cacheKey);
    if (cached) {
        console.log(`[Cache] Hit detail: ${cacheKey}`);
        return res.json({ list: [cached] });  // 包装为 list 数组
    }

    try {
        console.log(`[Detail] ${site.name} -> ID: ${id}`);
        const response = await axios.get(site.api, {
            params: { ac: 'detail', ids: id },
            timeout: 8000
        });

        const data = response.data;
        if (data.list && data.list.length > 0) {
            const detail = data.list[0];
            cacheManager.set('detail', cacheKey, detail, 3600); // 缓存1小时
            res.json({ list: [detail] });  // 包装为 list 数组
        } else {
            res.status(404).json({ error: 'Not found' });
        }
    } catch (error) {
        console.error(`[Detail Error] ${site.name}:`, error.message);
        res.status(500).json({ error: 'Detail fetch failed' });
    }
});

// 3b. 批量测试源可用性 API (服务器端测速)
app.post('/api/test-sources', async (req, res) => {
    const { sources } = req.body;

    if (!sources || !Array.isArray(sources)) {
        return res.status(400).json({ error: 'Invalid sources parameter' });
    }

    console.log(`[Test Sources] 开始测试 ${sources.length} 个源...`);

    // 设置整体超时保护 (15秒)
    const overallTimeout = setTimeout(() => {
        console.warn('[Test Sources] 整体超时,返回已完成的结果');
    }, 15000);

    try {
        // 并发测试所有源
        const testResults = await Promise.all(sources.map(async (source) => {
            try {
                const startTime = Date.now();

                // 1. 获取详情
                const sites = getDB().sites;
                const site = sites.find(s => s.key === source.site_key);

                if (!site) {
                    return { ...source, available: false, latency: 9999, error: 'Site not found' };
                }

                const detailRes = await axios.get(site.api, {
                    params: { ac: 'detail', ids: source.vod_id },
                    timeout: 3000  // 降低超时时间
                });

                if (!detailRes.data.list || detailRes.data.list.length === 0) {
                    return { ...source, available: false, latency: 9999, error: 'No detail' };
                }

                const detail = detailRes.data.list[0];
                let playUrl = detail.vod_play_url || '';

                // 2. 解析第一个视频 URL
                if (playUrl.includes('$$$')) {
                    const sets = playUrl.split('$$$');
                    playUrl = sets.find(s => s.toLowerCase().includes('m3u8')) || sets[0];
                }

                const firstEp = playUrl.split('#')[0];
                const parts = firstEp.split('$');
                const videoUrl = parts.length > 1 ? parts[1] : parts[0];

                if (!videoUrl || !videoUrl.startsWith('http')) {
                    return { ...source, available: false, latency: 9999, error: 'Invalid URL' };
                }

                // 3. 测试 m3u8 URL 可用性 (使用 GET 请求前几个字节)
                const testRes = await axios.get(videoUrl, {
                    timeout: 3000,
                    maxContentLength: 1024,  // 只下载前 1KB
                    validateStatus: (status) => status < 500,
                    headers: {
                        'Range': 'bytes=0-1023'  // 请求前 1KB
                    }
                });

                const latency = Date.now() - startTime;

                // 4. 检查状态码
                if (testRes.status === 403 || testRes.status === 404) {
                    console.log(`[Test] ${source.site_name} - 不可用 (${testRes.status})`);
                    return { ...source, available: false, latency: 9999, error: `HTTP ${testRes.status}` };
                }

                if (testRes.status >= 200 && testRes.status < 400) {
                    console.log(`[Test] ${source.site_name} - 可用 (${latency}ms)`);
                    return {
                        ...source,
                        available: true,
                        latency,
                        _cachedDetail: detail  // 修正字段名
                    };
                }

                return { ...source, available: false, latency: 9999, error: `HTTP ${testRes.status}` };

            } catch (error) {
                console.log(`[Test] ${source.site_name} - 失败: ${error.message}`);
                return { ...source, available: false, latency: 9999, error: error.message };
            }
        }));

        clearTimeout(overallTimeout);

        // 5. 过滤掉不可用的源
        const availableSources = testResults.filter(s => s.available);

        // 6. 按延迟排序
        availableSources.sort((a, b) => a.latency - b.latency);

        console.log(`[Test Sources] 完成: ${availableSources.length}/${sources.length} 个源可用`);

        res.json({
            total: sources.length,
            available: availableSources.length,
            sources: availableSources
        });

    } catch (error) {
        clearTimeout(overallTimeout);
        console.error('[Test Sources] 整体错误:', error);
        res.status(500).json({ error: 'Test failed', message: error.message });
    }
});

// 4. M3U8 代理接口
app.get('/api/proxy/m3u8', async (req, res) => {
    const encodedUrl = req.query.url;

    if (!encodedUrl) {
        return res.status(400).send('Missing url parameter');
    }

    try {
        // 解码 URL
        const originalUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
        console.log(`[M3U8 Proxy] ${originalUrl}`);

        // 获取 m3u8 文件
        const response = await axios.get(originalUrl, {
            responseType: 'text',
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        let content = response.data;
        const baseUrl = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);

        // 重写 m3u8 内容中的 URL
        content = content.split('\n').map(line => {
            // 跳过注释和空行
            if (line.startsWith('#')) {
                // 处理 EXT-X-KEY (加密密钥)
                if (line.startsWith('#EXT-X-KEY')) {
                    return line.replace(/URI="([^"]+)"/g, (match, uri) => {
                        // 将相对路径转为绝对路径
                        const absoluteUri = uri.startsWith('http') ? uri : new URL(uri, baseUrl).href;
                        // 使用 key 代理
                        const proxyUri = `/api/proxy/key?url=${Buffer.from(absoluteUri).toString('base64')}`;
                        return `URI="${proxyUri}"`;
                    });
                }
                return line;
            }

            if (line.trim()) {
                // 将相对 URL 转为绝对 URL
                const absoluteUrl = line.startsWith('http') ? line : new URL(line.trim(), baseUrl).href;

                // 根据文件类型选择代理端点
                if (absoluteUrl.endsWith('.m3u8') || absoluteUrl.includes('.m3u8?')) {
                    return `/api/proxy/m3u8?url=${Buffer.from(absoluteUrl).toString('base64')}`;
                } else if (absoluteUrl.endsWith('.ts') || absoluteUrl.includes('.ts?')) {
                    return `/api/proxy/ts?url=${Buffer.from(absoluteUrl).toString('base64')}`;
                } else {
                    // 其他资源也通过 ts 代理
                    return `/api/proxy/ts?url=${Buffer.from(absoluteUrl).toString('base64')}`;
                }
            }

            return line;
        }).join('\n');

        // 设置响应头
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(content);

    } catch (error) {
        console.error(`[M3U8 Proxy Error]:`, error.message);
        res.status(502).send('Failed to fetch m3u8');
    }
});

// 5. TS 分片代理接口
app.get('/api/proxy/ts', async (req, res) => {
    const encodedUrl = req.query.url;

    if (!encodedUrl) {
        return res.status(400).send('Missing url parameter');
    }

    try {
        const originalUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
        console.log(`[TS Proxy] ${originalUrl}`);

        const response = await axios({
            url: originalUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // 设置响应头
        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        res.setHeader('Access-Control-Allow-Origin', '*');

        // 流式转发
        response.data.pipe(res);

    } catch (error) {
        console.error(`[TS Proxy Error]:`, error.message);
        res.status(502).send('Failed to fetch ts');
    }
});

// 6. 加密密钥文件代理接口
app.get('/api/proxy/key', async (req, res) => {
    const encodedUrl = req.query.url;

    if (!encodedUrl) {
        return res.status(400).send('Missing url parameter');
    }

    try {
        const originalUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
        console.log(`[KEY Proxy] ${originalUrl}`);

        const response = await axios({
            url: originalUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // 设置响应头
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        res.setHeader('Access-Control-Allow-Origin', '*');

        // 流式转发密钥文件
        response.data.pipe(res);

    } catch (error) {
        console.error(`[KEY Proxy Error]:`, error.message);
        res.status(502).send('Failed to fetch key');
    }
});

// 7. 图片代理 API (直接转发,不缓存)
app.get('/api/tmdb-image/:size/:filename', async (req, res) => {
    const { size, filename } = req.params;
    const allowSizes = ['w300', 'w342', 'w500', 'w780', 'w1280', 'original'];

    // 安全检查
    if (!allowSizes.includes(size) || !/^[a-zA-Z0-9_\-\.]+$/.test(filename)) {
        return res.status(400).send('Invalid parameters');
    }

    const tmdbUrl = `https://image.tmdb.org/t/p/${size}/${filename}`;

    try {
        console.log(`[Image Proxy] Forwarding: ${tmdbUrl}`);
        const response = await axios({
            url: tmdbUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 10000
        });

        // 设置响应头
        res.setHeader('Content-Type', response.headers['content-type']);
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }

        // 启用浏览器缓存 (可选,建议保留以减少重复请求)
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 缓存1天

        // 流式转发图片数据
        response.data.pipe(res);
    } catch (error) {
        console.error(`[Image Proxy Error] ${tmdbUrl}:`, error.message);
        res.status(404).send('Image not found');
    }
});

// 5. 认证检查 API
app.get('/api/auth/check', (req, res) => {
    // 简单检查 header 中的 token (示例：实际需更强验证)
    // 这里简单返回是否需要密码
    res.json({ needsPassword: !!ACCESS_PASSWORD });
});

// 6. 验证密码 API
app.post('/api/auth/verify', (req, res) => {
    const { password } = req.body;
    if (!ACCESS_PASSWORD) return res.json({ success: true });

    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (hash === PASSWORD_HASH) {
        res.json({ success: true, token: 'session_token_placeholder' });
    } else {
        res.json({ success: false });
    }
});

// Helper: Get DB data (Local or Remote)
function getDB() {
    if (remoteDbCache) return remoteDbCache;
    return JSON.parse(fs.readFileSync(DATA_FILE));
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
