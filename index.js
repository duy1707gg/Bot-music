// index.js — Discord music bot (yt-dlp first; proper Netscape cookies; Railway-friendly)

import 'dotenv/config';

import {
    AudioPlayerStatus,
    createAudioPlayer,
    createAudioResource,
    getVoiceConnection,
    joinVoiceChannel,
    NoSubscriberBehavior,
    StreamType,
} from '@discordjs/voice';

import ytdl from '@distube/ytdl-core';
import {
    ChannelType,
    Client,
    Events,
    GatewayIntentBits,
    MessageFlags,
} from 'discord.js';

import { execFile, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import play from 'play-dl';
import SpotifyWebApi from 'spotify-web-api-node';

// ================= Config =================
const YTDLP_BIN = process.env.YTDLP_BIN || '/usr/local/bin/yt-dlp';
const USE_YTDL_FALLBACK = true; // cuối cùng mới dùng ytdl-core nếu cần

// ================= Cookie helpers (Railway-safe) =================
function parseHeaderToArray(str) {
    // "A=B; C=D" -> [{name:'A', value:'B'}, ...]
    return String(str)
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((pair) => {
            const i = pair.indexOf('=');
            const name = i === -1 ? pair : pair.slice(0, i);
            const value = i === -1 ? '' : pair.slice(i + 1);
            return { name, value };
        });
}

function sanitizeCookies(arr) {
    const nameOk = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/; // RFC token
    return (arr || [])
        .map((c) => ({
            name: String(c.name || c.key || '').trim(),
            value: String(c.value || '').replace(/[\r\n]/g, ''),
            domain: c.domain || '.youtube.com',
            path: c.path || '/',
            secure: c.secure ?? true,
            httpOnly: c.httpOnly ?? false,
            expires: c.expires,
        }))
        .filter((c) => c.name && nameOk.test(c.name) && !/[;\r\n]/.test(c.value));
}

function getCookiesFromEnv() {
    if (process.env.YT_COOKIE_B64) {
        try {
            const json = Buffer.from(process.env.YT_COOKIE_B64, 'base64').toString('utf8');
            const arr = JSON.parse(json);
            return sanitizeCookies(arr);
        } catch (e) {
            console.warn('[YT] YT_COOKIE_B64 không hợp lệ:', e?.message || e);
        }
    }
    if (process.env.YT_COOKIE) {
        const raw = process.env.YT_COOKIE.trim();
        if (raw.startsWith('[')) {
            try {
                return sanitizeCookies(JSON.parse(raw));
            } catch (e) {
                console.warn('[YT] YT_COOKIE(JSON) không hợp lệ:', e?.message || e);
            }
        }
        return sanitizeCookies(parseHeaderToArray(raw));
    }
    return null;
}

const cookies = getCookiesFromEnv();

// --- Ghi file Netscape cho yt-dlp ---
function toNetscapeLine({ domain, includeSub = true, path = '/', secure = true, expiry, name, value }) {
    // Netscape: domain \t includeSub \t path \t secure \t expiry(epoch) \t name \t value
    const dom = domain?.startsWith('.') ? domain : `.${domain || 'youtube.com'}`;
    const inc = includeSub ? 'TRUE' : 'FALSE';
    const sec = secure ? 'TRUE' : 'FALSE';
    const exp = Number.isFinite(expiry) ? Math.trunc(expiry) : Math.trunc(Date.now() / 1000) + 3600 * 24 * 30;
    return `${dom}\t${inc}\t${path}\t${sec}\t${exp}\t${name}\t${value}`;
}

function writeNetscapeCookieFile(cookiesArr) {
    if (!cookiesArr || !cookiesArr.length) return null;
    const lines = [
        '# Netscape HTTP Cookie File',
        '# Generated at runtime for yt-dlp',
    ];
    for (const c of cookiesArr) {
        if (!c?.name || c.value == null) continue;
        const expiry =
            c.expires != null
                ? Math.trunc(new Date(c.expires).getTime() / 1000)
                : undefined;
        lines.push(
            toNetscapeLine({
                domain: c.domain || '.youtube.com',
                includeSub: true,
                path: c.path || '/',
                secure: c.secure !== false,
                expiry,
                name: c.name || c.key,
                value: String(c.value).replace(/\r|\n/g, ''),
            }),
        );
    }
    const p = '/tmp/youtube.netscape.cookies.txt';
    writeFileSync(p, lines.join('\n') + '\n', 'utf8');
    console.log(`[YT] Netscape cookie file written: ${p} (${lines.length - 2} entries)`);
    return p;
}

// play-dl token (header string)
if (cookies && cookies.length) {
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    try {
        await play.setToken({ youtube: { cookie: cookieHeader } });
        console.log('[YT] cookie loaded for play-dl');
    } catch (e) {
        console.warn('[YT] play-dl setToken failed:', e?.message || e);
    }
}

// ytdl-core agent (định dạng mới)
let ytdlAgent = undefined;
if (cookies && cookies.length) {
    try {
        ytdlAgent = ytdl.createAgent(cookies);
        console.log('[YT] ytdl agent ready');
    } catch (e) {
        console.warn('[YT] ytdl.createAgent failed:', e?.message || e);
    }
}

// ================= Helpers: YouTube search matcher =================
function parseDurationStr(s) {
    if (!s) return null;
    const parts = s.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    let sec = 0;
    for (let i = 0; i < parts.length; i++) sec = sec * 60 + parts[i];
    return sec;
}
function normalizeText(str) {
    return (str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function titleLooksBad(title) {
    const t = normalizeText(title);
    const bad = /(live|lyrics|lirik|cover|remix|sped up|nightcore|8d|slowed|reverb)/i;
    return bad.test(t);
}
function channelPriority(name = '') {
    const n = (name || '').toLowerCase();
    if (n.includes(' - topic') || n.includes('topic')) return 0;
    if (n.includes('vevo') || n.includes('official')) return 1;
    return 3;
}
function scoreResult({ title, channel, durationSec }, want) {
    const D = want.durationSec ?? null;
    let score = 0;
    if (D != null && durationSec != null) {
        const diff = Math.abs(durationSec - D);
        score += diff <= 3 ? 0 : diff <= 6 ? 1 : diff <= 10 ? 3 : diff <= 20 ? 8 : 20 + Math.floor((diff - 20) / 5);
    } else {
        score += 5;
    }
    if (titleLooksBad(title)) score += 8;
    score += channelPriority(channel);
    const t = normalizeText(title);
    const wantTokens = (normalizeText(want.track) + ' ' + normalizeText(want.artist))
        .split(' ')
        .filter(Boolean);
    const covered = wantTokens.filter((tok) => t.includes(tok)).length;
    const coverage = covered / Math.max(1, wantTokens.length);
    score += (1 - coverage) * 6;
    score -= coverage * 1.5;
    return score;
}
async function bestYouTubeForTrack({ track, artist, durationMs }) {
    const query = `${track} ${artist} audio`;
    const results = await play.search(query, { source: { youtube: 'video' }, limit: 8 }).catch(() => []);
    if (!results || results.length === 0) return null;
    const want = { track, artist, durationSec: durationMs ? Math.round(durationMs / 1000) : null };
    const cooked = results.map((r) => {
        const durSec = typeof r.durationInSec === 'number' ? r.durationInSec : parseDurationStr(r.duration);
        return {
            url: r.url,
            title: r.title || '',
            channel: r.channel?.name || r.channel || '',
            durationSec: durSec ?? null,
        };
    });
    cooked.sort((a, b) => scoreResult(a, want) - scoreResult(b, want));
    return cooked[0]?.url || null;
}

// ================= Helpers: YouTube URL handling =================
function normalizeYouTubeUrl(raw) {
    let s = (raw || '').trim();
    if (/^(youtube\.com|youtu\.be)\//i.test(s)) s = 'https://' + s;
    if (/^https?:\/\/youtube\.com\//i.test(s)) s = s.replace('://youtube.com/', '://www.youtube.com/');
    return s;
}
function getYTParams(raw) {
    try {
        const s = normalizeYouTubeUrl(raw);
        const u = new URL(s);
        const q = u.searchParams;
        return {
            v: q.get('v'),
            list: q.get('list'),
            index: q.get('index') ? parseInt(q.get('index'), 10) : undefined,
            cleanVideoUrl: (id) => `https://www.youtube.com/watch?v=${id}`,
        };
    } catch {
        return { v: null, list: null, index: undefined, cleanVideoUrl: (id) => `https://www.youtube.com/watch?v=${id}` };
    }
}
function tryExtractRDSeed(list) {
    const m = /^RD([A-Za-z0-9_-]{11})$/i.exec(String(list || ''));
    return m ? m[1] : null;
}

// ====== Radio builder (giả lập RD) ======
function uniqUrls(urls) {
    const seen = new Set();
    const out = [];
    for (const u of urls) {
        const key = u.replace(/&pp=[^&]+/g, '');
        if (!seen.has(key)) {
            seen.add(key);
            out.push(u);
        }
    }
    return out;
}

async function buildRadioFromSeed(seedUrl, maxCount = 25) {
    let related = [];
    try {
        const info = await play.video_info(seedUrl);
        related = info?.related_videos || [];
    } catch (_) { }

    if (!related.length) {
        const title = await fetchTitleWithTimeout(seedUrl, 1200);
        const term = title === seedUrl ? 'official audio' : title;
        const results = await play.search(term, { source: { youtube: 'video' }, limit: 40 }).catch(() => []);
        related =
            results?.map((r) => ({
                url: r.url,
                title: r.title || '',
                channel: r.channel?.name || r.channel || '',
                durationInSec: typeof r.durationInSec === 'number' ? r.durationInSec : parseDurationStr(r.duration),
            })) || [];
    }

    const cleaned = related
        .filter((r) => r?.url)
        .map((r) => ({
            url: r.url,
            title: r.title || '',
            channel: r.channel || '',
            durationSec: r.durationInSec ?? null,
        }))
        .filter((r) => !titleLooksBad(r.title))
        .sort((a, b) => {
            const pa = channelPriority(a.channel);
            const pb = channelPriority(b.channel);
            if (pa !== pb) return pa - pb;
            const ba = titleLooksBad(a.title) ? 1 : 0;
            const bb = titleLooksBad(b.title) ? 1 : 0;
            if (ba !== bb) return ba - bb;
            return 0;
        });

    const urls = uniqUrls(cleaned.map((x) => x.url));
    const seedClean = (await resolveYouTubePlayableUrl(seedUrl)) || seedUrl;
    const finalList = [seedClean, ...urls.filter((u) => u !== seedClean)].slice(0, Math.max(2, maxCount));
    return finalList;
}

async function resolveYouTubePlayableUrl(rawUrl) {
    const norm = normalizeYouTubeUrl(rawUrl);
    try {
        const u = new URL(norm);
        if (u.hostname === 'music.youtube.com') u.hostname = 'www.youtube.com';
        if (u.pathname.startsWith('/shorts/')) {
            const id = u.pathname.split('/')[2];
            if (id) return `https://www.youtube.com/watch?v=${id}`;
        }
        if (u.hostname === 'youtu.be') {
            const id = (u.pathname || '/').replace('/', '').trim();
            if (id) return `https://www.youtube.com/watch?v=${id}`;
        }
    } catch { }
    const { v, list, index, cleanVideoUrl } = getYTParams(norm);
    if (v) return cleanVideoUrl(v);

    if (list && !/^RD/i.test(list)) {
        const pl = await play.playlist_info(`https://www.youtube.com/playlist?list=${list}`, { incomplete: true });
        const vids = await pl.all_videos();
        const i = index && index > 0 ? index - 1 : 0;
        const chosen = vids[i] || vids[0];
        if (!chosen) throw new Error('Playlist trống hoặc không lấy được video.');
        return chosen.url;
    }

    if (list && /^RD/i.test(list)) {
        const seed = v || tryExtractRDSeed(list);
        if (seed) return `https://www.youtube.com/watch?v=${seed}`;
        throw new Error('Radio playlist (RD) không có video cụ thể.');
    }

    return norm;
}

// ================= RD/Playlist expansion via yt-dlp =================
async function expandRDWithYtDlp(url) {
    const cookiePath = cookies?.length ? writeNetscapeCookieFile(cookies) : null;
    return await new Promise((resolve, reject) => {
        const args = [
            '-J', '--flat-playlist',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
            '--force-ipv4',
            url,
        ];

        if (cookiePath) args.unshift('--cookies', cookiePath);
        execFile(
            YTDLP_BIN,
            args,
            { maxBuffer: 1024 * 1024 * 32 },
            (err, stdout, stderr) => {
                if (err) return reject(stderr || err);
                try {
                    const data = JSON.parse(stdout);
                    const urls = (data?.entries || [])
                        .map((e) => e?.url || e?.id)
                        .filter(Boolean)
                        .map((x) => (String(x).startsWith('http') ? x : `https://www.youtube.com/watch?v=${x}`));
                    resolve(urls);
                } catch (e) {
                    reject(e);
                }
            },
        );
    });
}

// ============== Stream trực tiếp bằng yt-dlp (stdout) ==============
function buildYtDlpAudioResource(url) {
    const cookiePath = cookies?.length ? writeNetscapeCookieFile(cookies) : null;

    const YT_CLIENT = process.env.YTDLP_CLIENT || 'android'; // 'android' | 'web' | 'ios' | 'tv_embedded'
    const YT_FORMAT = process.env.YTDLP_FORMAT || 'ba[ext=m4a]/ba[acodec^=mp4a]/ba/best';

    const args = [
        '-f', YT_FORMAT,           // format rộng: thử m4a, rồi mp4a, rồi bestaudio/best
        '--no-playlist',
        '-o', '-',                 // stdout
        '--quiet', '--no-warnings',
        '--geo-bypass',
        '--force-ipv4',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        '--extractor-args', `youtube:player_client=${YT_CLIENT}`,
        '--retry-streams', '3',
        '--fragment-retries', '3',
        url,
    ];
    if (cookiePath) args.unshift('--cookies', cookiePath); // NHỚ: chèn trước URL

    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('error', (e) => console.error('[yt-dlp spawn error]', e));
    proc.stderr.on('data', (d) => {
        const s = d.toString();
        if (s && !/^\s*$/.test(s)) console.warn('[yt-dlp]', s.trim());
    });

    const resource = createAudioResource(proc.stdout, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
    });
    resource.playStream?.on?.('error', (err) => console.error('[yt-dlp stream error]', err));
    return resource;
}

// ================= Spotify helpers =================
const spotify = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
});
let spotifyTokenExpiry = 0;
async function ensureSpotifyToken() {
    if (!spotify.getClientId() || !spotify.getClientSecret()) return;
    const now = Date.now();
    if (now < spotifyTokenExpiry - 10_000) return;
    const data = await spotify.clientCredentialsGrant();
    spotify.setAccessToken(data.body.access_token);
    spotifyTokenExpiry = now + data.body.expires_in * 1000;
}
function parseSpotifyId(spotifyUrl) {
    try {
        const u = new URL(spotifyUrl);
        if (!/open\.spotify\.com$/i.test(u.hostname)) return null;
        const [, type, id] = u.pathname.split('/');
        if (!type || !id) return null;
        return { type, id: id.split('?')[0] };
    } catch {
        return null;
    }
}
async function resolveSpotifyToYoutubeUrls(spotifyUrl) {
    const info = parseSpotifyId(spotifyUrl);
    if (!info) return [spotifyUrl];
    await ensureSpotifyToken().catch(() => { });
    const urls = [];
    if (info.type === 'track') {
        const t = (await spotify.getTrack(info.id)).body;
        const best = await bestYouTubeForTrack({
            track: t.name,
            artist: t.artists?.[0]?.name || '',
            durationMs: t.duration_ms,
        });
        if (best) urls.push(best);
    } else if (info.type === 'album') {
        const album = (await spotify.getAlbum(info.id)).body;
        let offset = 0,
            limit = 50;
        const total = album.tracks.total;
        while (offset < total) {
            const page = (await spotify.getAlbumTracks(info.id, { limit, offset })).body;
            for (const it of page.items) {
                const best = await bestYouTubeForTrack({
                    track: it.name,
                    artist: it.artists?.[0]?.name || album.artists?.[0]?.name || '',
                    durationMs: it.duration_ms,
                });
                if (best) urls.push(best);
            }
            offset += page.items.length;
        }
    } else if (info.type === 'playlist') {
        let offset = 0,
            limit = 100,
            total = 0;
        do {
            const page = (await spotify.getPlaylistTracks(info.id, { limit, offset })).body;
            total = page.total ?? total;
            for (const it of page.items) {
                const tr = it.track;
                if (!tr) continue;
                const best = await bestYouTubeForTrack({
                    track: tr.name,
                    artist: tr.artists?.[0]?.name || '',
                    durationMs: tr.duration_ms,
                });
                if (best) urls.push(best);
            }
            offset += page.items?.length || 0;
        } while (offset < total);
    }
    return urls.length ? urls : [spotifyUrl];
}

// ================= Titles & formatting =================
async function fetchTitle(url) {
    try {
        if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
            const info = await play.video_basic_info(url).catch(() => null);
            if (info?.video_details?.title) return info.video_details.title;
        }
        if (ytdl.validateURL(url)) {
            const info = await ytdl.getBasicInfo(url, ytdlAgent ? { agent: ytdlAgent } : undefined);
            return info?.videoDetails?.title || url;
        }
    } catch (_) { }
    return url;
}
async function fetchTitleWithTimeout(url, ms = 1500) {
    return await Promise.race([
        (async () => await fetchTitle(url))(),
        new Promise((resolve) => setTimeout(() => resolve(url), ms)),
    ]);
}
function formatQueuePage(ctx, page = 1, perPage = 10) {
    const total = ctx.queue.length;
    if (total === 0) return `📭 Hàng đợi trống.`;
    const pages = Math.ceil(total / perPage);
    const p = Math.min(Math.max(page, 1), pages);
    const startIndex = (p - 1) * perPage;
    const lines = ctx.queue.slice(startIndex, startIndex + perPage).map((item, i) => {
        const idx = startIndex + i + 1;
        const safe = item || {};
        const title = safe.title || safe.url || '(unknown)';
        return `**${idx}.** ${title}`;
    });
    return `📄 Hàng đợi (${total} bài) — trang ${p}/${pages}\n` + lines.join('\n');
}
function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j]];
    }
}
function printNowPlaying(titleOrUrl) {
    console.log(`🎶 Now Playing: ${titleOrUrl}`);
}

// ================= Core stream helpers =================
async function createResourceFromUrl(urlInput) {
    let finalUrl = urlInput;

    // YouTube
    if (
        /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(finalUrl) ||
        /^(youtube\.com|youtu\.be)\//i.test(finalUrl)
    ) {
        try {
            finalUrl = await resolveYouTubePlayableUrl(finalUrl);
        } catch (e) {
            console.warn('[resolveYouTubePlayableUrl] note:', String(e?.message || e || ''));
        }

        // Try 1: yt-dlp (web client + cookies)
        try {
            const res = buildYtDlpAudioResource(finalUrl);
            return { resource: res, display: finalUrl };
        } catch (e) {
            console.warn('[yt-dlp stdout] failed:', e?.message || e);
        }

        // Try 2: play-dl (thường fail CAPTCHA, nhưng cứ thử)
        try {
            const info = await play.stream(finalUrl, { quality: 2 });
            return {
                resource: createAudioResource(info.stream, { inputType: info.type, inlineVolume: true }),
                display: finalUrl,
            };
        } catch (e) {
            console.warn('[play-dl] direct stream failed', e?.message || e);
        }

        // Try 3: mirror-search bằng play-dl
        try {
            const title = await fetchTitleWithTimeout(finalUrl, 1200);
            const term = title === finalUrl ? 'official audio' : title;
            const candidates = await play.search(term, { source: { youtube: 'video' }, limit: 6 }).catch(() => []);
            for (const c of candidates || []) {
                try {
                    const info2 = await play.stream(c.url, { quality: 2 });
                    return {
                        resource: createAudioResource(info2.stream, { inputType: info2.type, inlineVolume: true }),
                        display: c.url,
                    };
                } catch { }
            }
        } catch (e) {
            console.warn('[mirror-search] failed:', e?.message || e);
        }

        // Try 4: ytdl-core (cuối cùng mới thử)
        if (USE_YTDL_FALLBACK) {
            try {
                const ytStream = ytdl(finalUrl, {
                    filter: 'audioonly',
                    quality: 'highestaudio',
                    highWaterMark: 1 << 25,
                    ...(ytdlAgent ? { agent: ytdlAgent } : {}),
                });
                return {
                    resource: createAudioResource(ytStream, { inputType: StreamType.Arbitrary, inlineVolume: true }),
                    display: finalUrl,
                };
            } catch (e) {
                console.warn('[ytdl] failed:', e?.message || e);
            }
        }

        throw new Error('Không stream được từ YouTube (đã thử nhiều cách).');
    }

    // Spotify → đổi sang YouTube (playlist/album: lấy bài đầu)
    if (/^(https?:\/\/)?open\.spotify\.com\//i.test(urlInput)) {
        const ytUrls = await resolveSpotifyToYoutubeUrls(urlInput);
        finalUrl = ytUrls[0];
    }

    // Nguồn khác: thử play-dl
    const kind = await play.validate(finalUrl);
    let streamInfo = null;
    if (kind) {
        streamInfo = await play.stream(finalUrl, { quality: 2 }).catch(() => null);
    } else {
        streamInfo =
            (await play.stream_from_info(await play.video_basic_info(finalUrl)).catch(() => null)) ||
            (await play.stream(finalUrl).catch(() => null));
    }
    if (!streamInfo) throw new Error('Không tạo được stream từ URL này.');
    return {
        resource: createAudioResource(streamInfo.stream, { inputType: streamInfo.type, inlineVolume: true }),
        display: finalUrl,
    };
}

// ================= expandToUrls (playlist/album/RD/Spotify) =================
async function expandToUrls(rawUrl) {
    if (
        /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(rawUrl) ||
        /^(youtube\.com|youtu\.be)\//i.test(rawUrl)
    ) {
        const { v, list } = getYTParams(rawUrl);
        if (v && !list) return [await resolveYouTubePlayableUrl(rawUrl)].filter(Boolean);
        if (list) {
            if (/^RD/i.test(String(list))) {
                try {
                    const urls = (await expandRDWithYtDlp(normalizeYouTubeUrl(rawUrl))).filter(
                        (u) => typeof u === 'string' && u.startsWith('http'),
                    );
                    if (urls.length >= 2) return Array.from(new Set(urls));
                    const seed = v || tryExtractRDSeed(list);
                    if (seed) {
                        const seedUrl = `https://www.youtube.com/watch?v=${seed}`;
                        const radio = await buildRadioFromSeed(seedUrl, 25);
                        return radio;
                    }
                    return urls || [];
                } catch {
                    const seed = v || tryExtractRDSeed(list);
                    if (!seed) return [];
                    const seedUrl = `https://www.youtube.com/watch?v=${seed}`;
                    const radio = await buildRadioFromSeed(seedUrl, 25);
                    return radio;
                }
            }
            const canonical = `https://www.youtube.com/playlist?list=${list}`;
            try {
                const pl = await play.playlist_info(canonical, { incomplete: true });
                const vids = await pl.all_videos();
                const urls1 = vids.map((vv) => vv?.url).filter((u) => typeof u === 'string' && u.startsWith('http'));
                return Array.from(new Set(urls1));
            } catch (e) {
                console.warn('[play-dl playlist] failed -> fallback yt-dlp:', e?.message || e);
                const urls2 = (await expandRDWithYtDlp(canonical)).filter(
                    (u) => typeof u === 'string' && u.startsWith('http'),
                );
                if (urls2.length) return Array.from(new Set(urls2));
                return [];
            }
        }
    }
    if (/^(https?:\/\/)?open\.spotify\.com\//i.test(rawUrl)) {
        return await resolveSpotifyToYoutubeUrls(rawUrl);
    }
    return [rawUrl];
}

// ================= State & Core =================
/**
 * ctx: {
 *   player, connection,
 *   queue: Array<{ url: string, title?: string }>,
 *   now?: { url: string, title?: string },
 *   textChannelId?: string,
 *   loopMode: 'none' | 'one' | 'all'
 * }
 */
const contexts = new Map(); // guildId -> ctx

function getOrCreate(guild, voiceChannel) {
    let ctx = contexts.get(guild.id);
    if (!ctx) {
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true,
        });

        const player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
        });

        connection.subscribe(player);

        ctx = { player, connection, queue: [], now: null, textChannelId: undefined, loopMode: 'none' };
        contexts.set(guild.id, ctx);

        player.on(AudioPlayerStatus.Idle, async () => {
            try {
                if (ctx.loopMode === 'one' && ctx.now) {
                    await playOne(ctx, ctx.now.url, { announce: true });
                } else if (ctx.queue.length > 0) {
                    let next = null;
                    while (ctx.queue.length > 0 && !next) {
                        const cand = ctx.queue.shift();
                        if (cand && cand.url) next = cand;
                    }
                    if (next) {
                        await playOne(ctx, next.url, { announce: true });
                    } else {
                        ctx.now = null;
                    }
                    if (ctx.loopMode === 'all' && ctx.now) {
                        ctx.queue.push({ url: ctx.now.url, title: ctx.now.title });
                    }
                } else {
                    if (ctx.loopMode === 'all' && ctx.now) {
                        await playOne(ctx, ctx.now.url, { announce: true });
                    } else {
                        ctx.now = null;
                    }
                }
            } catch (e) {
                console.error('[AUTO-NEXT] error:', e);
                ctx.now = null;
            }
        });

        player.on('error', (err) => console.error('[PLAYER] error:', err));

        player.on(AudioPlayerStatus.Playing, () => {
            const titleOrUrl = ctx.now?.title || ctx.now?.url || '(unknown)';
            printNowPlaying(titleOrUrl);
        });

        connection.on('stateChange', (o, n) => console.log('[Conn]', o.status, '->', n.status));
    }
    return ctx;
}

async function announceNowPlaying(client, ctx) {
    try {
        if (!ctx.textChannelId || !ctx.now) return;
        const ch = await client.channels.fetch(ctx.textChannelId).catch(() => null);
        if (!ch || !('send' in ch)) return;
        const title = ctx.now.title || ctx.now.url;

        await ch.send({
            content: `🎶 **Now Playing:** ${title}`,
            flags: MessageFlags.SuppressNotifications,
        });
    } catch (e) {
        console.error('[ANNOUNCE] error:', e);
    }
}

async function playOne(ctx, url, { announce = false } = {}) {
    const built = await createResourceFromUrl(url);

    ctx.now = { url: built.display, title: undefined };

    try {
        ctx.player.play(built.resource);
    } catch (e) {
        const msg = String(e?.message || e || '');
        console.warn('[play] play() error:', msg);
        if (/already ended/i.test(msg)) {
            throw new Error('Nguồn stream kết thúc ngay khi bắt đầu (có thể bị chặn). Hãy thử URL khác.');
        }
        throw e;
    }

    built.resource.playStream?.on?.('error', (err) => console.error('[Stream error]', err));

    let title = built.display;
    try {
        title = await fetchTitleWithTimeout(built.display, 1500);
    } catch { }
    ctx.now.title = title;

    printNowPlaying(title);
    if (announce) await announceNowPlaying(client, ctx);
}

// ================= Bot setup & commands =================
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { guild } = interaction;
    if (!guild) return;

    // /play
    if (interaction.commandName === 'play') {
        const inputUrl = interaction.options.getString('url', true);
        console.log('[INT] /play from', interaction.user.tag, 'url=', inputUrl);
        await interaction.deferReply();

        try {
            const gm = await guild.members.fetch(interaction.user.id).catch(() => null);
            const voiceChannel = gm?.voice?.channel;
            if (!voiceChannel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(voiceChannel.type)) {
                return interaction.editReply('❗ Bạn cần vào voice channel trước.');
            }

            let ctx = getOrCreate(guild, voiceChannel);
            ctx.textChannelId = interaction.channelId;
            if (ctx.connection.joinConfig.channelId !== voiceChannel.id) {
                ctx.connection.destroy();
                contexts.delete(guild.id);
                ctx = getOrCreate(guild, voiceChannel);
                ctx.textChannelId = interaction.channelId;
            }

            ctx.queue.length = 0;
            await playOne(ctx, inputUrl, { announce: true });
            return interaction.editReply(`🎵 Đang phát: ${ctx.now?.title || ctx.now?.url}`);
        } catch (err) {
            console.error('[PLAY] error:', err);
            return interaction.editReply('❌ Có lỗi khi phát nhạc.');
        }
    }

    // /queue
    if (interaction.commandName === 'queue') {
        const inputUrl = interaction.options.getString('url', true);
        console.log('[INT] /queue from', interaction.user.tag, 'url=', inputUrl);
        await interaction.deferReply();

        try {
            const gm = await guild.members.fetch(interaction.user.id).catch(() => null);
            const voiceChannel = gm?.voice?.channel;
            if (!voiceChannel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(voiceChannel.type)) {
                return interaction.editReply('❗ Bạn cần vào voice channel trước.');
            }

            let ctx = getOrCreate(guild, voiceChannel);
            ctx.textChannelId = interaction.channelId;
            if (ctx.connection.joinConfig.channelId !== voiceChannel.id) {
                ctx.connection.destroy();
                contexts.delete(guild.id);
                ctx = getOrCreate(guild, voiceChannel);
                ctx.textChannelId = interaction.channelId;
            }

            const urlsRaw = await expandToUrls(inputUrl);
            const urls = Array.from(new Set((urlsRaw || []).filter((u) => typeof u === 'string' && u.startsWith('http'))));
            if (urls.length === 0) {
                return interaction.editReply('❌ Không lấy được URL hợp lệ từ liên kết này.');
            }
            const firstTitlesCount = Math.min(urls.length, 10);
            const titles = await Promise.all(urls.slice(0, firstTitlesCount).map((u) => fetchTitle(u)));
            const items = urls.map((u, idx) => ({
                url: u,
                title: idx < firstTitlesCount ? titles[idx] : undefined,
            }));

            ctx.queue.push(...items);

            if (!ctx.now && ctx.queue.length > 0 && ctx.player.state.status !== AudioPlayerStatus.Playing) {
                let first = null;
                while (ctx.queue.length > 0 && !first) {
                    const x = ctx.queue.shift();
                    if (x && x.url) first = x;
                }
                if (!first) return interaction.editReply('❗ Không có bài hợp lệ để phát.');
                await playOne(ctx, first.url, { announce: true });
                return interaction.editReply(`➕ Thêm **${urls.length}** mục. 🎵 Đang phát: ${ctx.now?.title || ctx.now?.url}`);
            }

            return interaction.editReply(
                `➕ Đã thêm **${urls.length}** mục vào hàng đợi. Hiện đang phát: ${ctx.now?.title ?? ctx.now?.url ?? '—'}`,
            );
        } catch (err) {
            console.error('[QUEUE] error:', err);
            return interaction.editReply('❌ Không thêm được vào queue.');
        }
    }

    // /skip
    if (interaction.commandName === 'skip') {
        const ctx = contexts.get(guild.id);
        if (!ctx || (!ctx.now && ctx.queue.length === 0)) {
            return interaction.reply({ content: '⏭️ Không có gì để skip.', ephemeral: true });
        }
        ctx.player.stop(true);
        return interaction.reply('⏭️ Đã skip.');
    }

    // /pause
    if (interaction.commandName === 'pause') {
        const ctx = contexts.get(guild.id);
        if (!ctx || ctx.player.state.status !== AudioPlayerStatus.Playing) {
            return interaction.reply({ content: '⏸️ Không có gì đang phát.', ephemeral: true });
        }
        const ok = ctx.player.pause(true);
        return interaction.reply(ok ? '⏸️ Đã tạm dừng.' : '⚠️ Không tạm dừng được.');
    }

    // /resume
    if (interaction.commandName === 'resume') {
        const ctx = contexts.get(guild.id);
        if (!ctx || ctx.player.state.status !== AudioPlayerStatus.Paused) {
            return interaction.reply({ content: '▶️ Không ở trạng thái tạm dừng.', ephemeral: true });
        }
        const ok = ctx.player.unpause();
        return interaction.reply(ok ? '▶️ Tiếp tục phát.' : '⚠️ Không tiếp tục được.');
    }

    // /loop
    if (interaction.commandName === 'loop') {
        const mode = interaction.options.getString('mode', true);
        const ctx = contexts.get(guild.id);
        if (!ctx) return interaction.reply({ content: '❗ Không có nhạc để loop.', ephemeral: true });
        if (!['none', 'one', 'all'].includes(mode)) {
            return interaction.reply({ content: '⚠️ Mode không hợp lệ! Dùng: none, one, all.', ephemeral: true });
        }
        ctx.loopMode = mode;
        return interaction.reply(`🔁 Chế độ loop: **${mode}**`);
    }

    // /nowplaying
    if (interaction.commandName === 'nowplaying') {
        const ctx = contexts.get(guild.id);
        if (!ctx || !ctx.now) return interaction.reply('ℹ️ Chưa có bài nào.');
        return interaction.reply(`🎶 Đang phát: ${ctx.now.title || ctx.now.url}`);
    }

    // /shuffle
    if (interaction.commandName === 'shuffle') {
        const ctx = contexts.get(guild.id);
        if (!ctx || ctx.queue.length === 0) {
            return interaction.reply({ content: '🔀 Hàng đợi đang trống.', ephemeral: true });
        }
        shuffleInPlace(ctx.queue);
        return interaction.reply('🔀 Đã xáo trộn hàng đợi (không ảnh hưởng bài đang phát).');
    }

    // /queue_list
    if (interaction.commandName === 'queue_list') {
        const ctx = contexts.get(guild.id);
        if (!ctx || ctx.queue.length === 0) {
            return interaction.reply('📭 Hàng đợi trống.');
        }
        await interaction.deferReply({ ephemeral: false });
        const page = interaction.options.getInteger('page') || 1;
        const perPage = 10;

        const startIndex = (Math.max(1, page) - 1) * perPage;
        const slice = ctx.queue.slice(startIndex, startIndex + perPage).filter(Boolean);

        await Promise.all(
            slice.map(async (item) => {
                if (!item.title) item.title = await fetchTitle(item.url);
            }),
        );

        const now = ctx.now ? `🎶 Đang phát: ${ctx.now.title || ctx.now.url}\n` : '';
        const body = formatQueuePage(ctx, page, perPage);
        return interaction.editReply(now + body);
    }

    // /stop
    if (interaction.commandName === 'stop') {
        const ctx = contexts.get(guild.id);
        if (!ctx) return interaction.reply({ content: '⏹️ Không có gì để dừng.', ephemeral: true });
        ctx.queue.length = 0;
        ctx.player.stop(true);
        ctx.now = null;
        return interaction.reply('⏹️ Đã dừng và xoá hàng đợi.');
    }

    // /leave
    if (interaction.commandName === 'leave') {
        const conn = getVoiceConnection(guild.id);
        if (!conn) return interaction.reply({ content: '👋 Bot không ở voice channel.', ephemeral: true });
        conn.destroy();
        contexts.delete(guild.id);
        return interaction.reply('👋 Đã rời channel.');
    }
});

client.login(process.env.TOKEN);
