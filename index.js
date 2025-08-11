// index.js — Discord music bot (robust YouTube fallbacks, optional YT_COOKIE)
// Node >= 18

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

import { ChannelType, Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';

import ytdl from '@distube/ytdl-core';
import play from 'play-dl';
import SpotifyWebApi from 'spotify-web-api-node';

import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { spawn } from 'node:child_process';
import ytdlp from 'yt-dlp-exec';

// ====== FFmpeg path (dùng bản embedded, không cần apt-get) ======
process.env.FFMPEG_PATH = ffmpegInstaller.path;

// ====== (Tuỳ chọn) Opus encoder, nên cài @discordjs/opus trong package.json ======
// npm i @discordjs/opus
// Nếu không cài, passthrough Opus vẫn OK, còn stream PCM cần encoder.

// ====== (Tuỳ chọn) nạp cookie YouTube nếu có (giúp vượt chặn "not a bot") ======
if (process.env.YT_COOKIE) {
    try {
        await play.setToken({ youtube: { cookie: process.env.YT_COOKIE } });
        console.log('[YT] cookie loaded for play-dl');
    } catch (e) {
        console.warn('[YT] cannot load cookie for play-dl:', e?.message || e);
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
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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
    const covered = wantTokens.filter(tok => t.includes(tok)).length;
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
    const cooked = results.map(r => {
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
            urlObj: u,
            cleanVideoUrl: (id) => `https://www.youtube.com/watch?v=${id}`,
        };
    } catch {
        return { v: null, list: null, index: undefined, urlObj: null, cleanVideoUrl: (id) => `https://www.youtube.com/watch?v=${id}` };
    }
}
async function resolveYouTubePlayableUrl(rawUrl) {
    const { v, list, index, cleanVideoUrl } = getYTParams(rawUrl);
    if (v) return cleanVideoUrl(v);

    if (list && !/^RD/i.test(list)) {
        const norm = normalizeYouTubeUrl(rawUrl);
        const pl = await play.playlist_info(norm, { incomplete: true });
        const videos = await pl.all_videos();
        const i = index && index > 0 ? index - 1 : 0;
        const chosen = videos[i] || videos[0];
        if (!chosen) throw new Error('Playlist trống hoặc không lấy được video.');
        return chosen.url;
    }

    if (list && /^RD/i.test(list)) {
        if (v) return cleanVideoUrl(v);
        throw new Error('Radio playlist (RD) không có video cụ thể.');
    }
    return normalizeYouTubeUrl(rawUrl);
}

// ================= Helpers: Spotify (Web API) =================
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
    spotifyTokenExpiry = now + (data.body.expires_in * 1000);
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
        const best = await bestYouTubeForTrack({ track: t.name, artist: t.artists?.[0]?.name || '', durationMs: t.duration_ms });
        if (best) urls.push(best);

    } else if (info.type === 'album') {
        const album = (await spotify.getAlbum(info.id)).body;
        let offset = 0, limit = 50;
        const total = album.tracks.total;
        while (offset < total) {
            const page = (await spotify.getAlbumTracks(info.id, { limit, offset })).body;
            for (const it of page.items) {
                const best = await bestYouTubeForTrack({
                    track: it.name,
                    artist: it.artists?.[0]?.name || album.artists?.[0]?.name || '',
                    durationMs: it.duration_ms
                });
                if (best) urls.push(best);
            }
            offset += page.items.length;
        }

    } else if (info.type === 'playlist') {
        let offset = 0, limit = 100, total = 0;
        do {
            const page = (await spotify.getPlaylistTracks(info.id, { limit, offset })).body;
            total = page.total ?? total;
            for (const it of page.items) {
                const tr = it.track;
                if (!tr) continue;
                const best = await bestYouTubeForTrack({
                    track: tr.name,
                    artist: tr.artists?.[0]?.name || '',
                    durationMs: tr.duration_ms
                });
                if (best) urls.push(best);
            }
            offset += page.items?.length || 0;
        } while (offset < total);
    }

    return urls.length ? urls : [spotifyUrl];
}

// ================= Titles & formatting (queue list + shuffle) =================
async function fetchTitle(url) {
    try {
        if (ytdl.validateURL(url)) {
            const info = await ytdl.getBasicInfo(url, {
                requestOptions: {
                    headers: {
                        'user-agent': 'Mozilla/5.0',
                        ...(process.env.YT_COOKIE ? { cookie: process.env.YT_COOKIE } : {}),
                    },
                },
            });
            return info?.videoDetails?.title || url;
        }
        if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
            const info = await play.video_basic_info(url).catch(() => null);
            return info?.video_details?.title || url;
        }
    } catch (_) { }
    return url;
}
async function fetchTitleWithTimeout(url, ms = 1500) {
    return await Promise.race([
        fetchTitle(url),
        new Promise(resolve => setTimeout(() => resolve(url), ms)),
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
        const title = item.title || item.url;
        return `**${idx}.** ${title}`;
    });
    return `📄 Hàng đợi (${total} bài) — trang ${p}/${pages}\n` + lines.join('\n');
}
function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}
function printNowPlaying(titleOrUrl) {
    console.log(`🎶 Now Playing: ${titleOrUrl}`);
}

// ================= Core stream helpers =================
async function ytDlpToPcmResource(finalUrl) {
    const info = await ytdlp(finalUrl, {
        dumpSingleJson: true,
        noWarnings: true,
        preferFreeFormats: true,
    });

    const fmt = info.formats?.find(f => f.vcodec === 'none' && f.acodec && f.url) || info;
    if (!fmt?.url) throw new Error('yt-dlp: no audio url');

    const ff = spawn(process.env.FFMPEG_PATH, [
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', fmt.url,
        '-ac', '2', '-ar', '48000',
        '-f', 's16le',
        'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    ff.on('error', (err) => console.error('[ffmpeg] error', err));
    const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    return resource;
}

function isAntiBotErrorMessage(msg) {
    return /confirm you.?re not a bot|captcha|403|429/i.test(msg || '');
}

async function createResourceFromUrl(urlInput) {
    let finalUrl = urlInput;

    // YouTube
    if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(finalUrl) || /^(youtube\.com|youtu\.be)\//i.test(finalUrl)) {
        try {
            finalUrl = await resolveYouTubePlayableUrl(finalUrl);
        } catch (e) {
            const msg = String(e?.message || e || '');
            if (/Radio playlist/i.test(msg)) {
                const idMatch = /v=([A-Za-z0-9_\-]+)/.exec(String(urlInput));
                if (idMatch) finalUrl = `https://www.youtube.com/watch?v=${idMatch[1]}`;
                else throw e;
            }
        }

        // Try 1: play-dl
        try {
            const info = await play.stream(finalUrl, { quality: 2 });
            return { resource: createAudioResource(info.stream, { inputType: info.type, inlineVolume: true }), display: finalUrl };
        } catch (e) {
            const msg = String(e?.message || e || '');
            console.warn('[play-dl] failed:', msg);
            if (isAntiBotErrorMessage(msg)) {
                return { resource: await ytDlpToPcmResource(finalUrl), display: finalUrl };
            }
        }

        // Try 2: ytdl
        try {
            const ytStream = ytdl(finalUrl, {
                filter: 'audioonly',
                quality: 'highestaudio',
                highWaterMark: 1 << 25,
                requestOptions: {
                    headers: {
                        'user-agent': 'Mozilla/5.0',
                        ...(process.env.YT_COOKIE ? { cookie: process.env.YT_COOKIE } : {}),
                    },
                },
            });
            return { resource: createAudioResource(ytStream, { inputType: StreamType.Arbitrary, inlineVolume: true }), display: finalUrl };
        } catch (e) {
            const msg = String(e?.message || e || '');
            console.warn('[ytdl] failed:', msg);
            if (isAntiBotErrorMessage(msg)) {
                return { resource: await ytDlpToPcmResource(finalUrl), display: finalUrl };
            }
        }

        // Try 3: mirror-search → play-dl again
        try {
            const title = await fetchTitleWithTimeout(finalUrl, 1200);
            const term = (title === finalUrl) ? 'official audio' : title;
            const candidates = await play.search(term, { source: { youtube: 'video' }, limit: 6 }).catch(() => []);
            for (const c of candidates || []) {
                try {
                    const info2 = await play.stream(c.url, { quality: 2 });
                    return { resource: createAudioResource(info2.stream, { inputType: info2.type, inlineVolume: true }), display: c.url };
                } catch { }
            }
        } catch (e) {
            console.warn('[mirror-search] failed:', e?.message || e);
        }

        // Last resort: yt-dlp
        return { resource: await ytDlpToPcmResource(finalUrl), display: finalUrl };
    }

    // Spotify → đổi sang YouTube (playlist/album: lấy bài đầu để phát ngay)
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

    return { resource: createAudioResource(streamInfo.stream, { inputType: streamInfo.type, inlineVolume: true }), display: finalUrl };
}

// Mở rộng URL thành danh sách (playlist YouTube/Spotify)
async function expandToUrls(rawUrl) {
    if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(rawUrl) || /^(youtube\.com|youtu\.be)\//i.test(rawUrl)) {
        const { v, list } = getYTParams(rawUrl);
        if (v && !list) return [await resolveYouTubePlayableUrl(rawUrl)];
        if (list) {
            if (/^RD/i.test(String(list))) {
                // Radio playlist: chỉ phát bài có v, còn queue thì bỏ qua
                if (v) return [`https://www.youtube.com/watch?v=${v}`];
                return [];
            }
            const pl = await play.playlist_info(normalizeYouTubeUrl(rawUrl), { incomplete: true });
            const vids = await pl.all_videos();
            return vids.map(vv => vv.url);
        }
    }
    if (/^(https?:\/\/)?open\.spotify\.com\//i.test(rawUrl)) {
        return await resolveSpotifyToYoutubeUrls(rawUrl);
    }
    return [rawUrl];
}

// ================ State & Core ================
/**
 * ctx: {
 *   player, connection,
 *   queue: Array<{ url: string, title?: string }>,
 *   now?: { url: string, title?: string },
 *   textChannelId?: string
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
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause }, // đổi thành Play để test nếu cần
        });

        connection.subscribe(player);

        ctx = { player, connection, queue: [], now: null, textChannelId: undefined };
        contexts.set(guild.id, ctx);

        player.on(AudioPlayerStatus.Idle, async () => {
            try {
                if (ctx.queue.length > 0) {
                    const next = ctx.queue.shift();
                    await playOne(ctx, next.url, { announce: true });
                } else {
                    ctx.now = null;
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

        // Debug kết nối
        ctx.connection.on('stateChange', (o, n) => console.log('[Conn]', o.status, '->', n.status));
    }
    return ctx;
}

async function announceNowPlaying(client, ctx) {
    try {
        if (!ctx.textChannelId || !ctx.now) return;
        const ch = await client.channels.fetch(ctx.textChannelId).catch(() => null);
        if (!ch || !('send' in ch)) return;
        const title = ctx.now.title || ctx.now.url;
        await ch.send({ content: `🎶 **Now Playing:** ${title}`, flags: MessageFlags.SuppressNotifications });
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
        if (/already ended/i.test(msg)) {
            console.warn('[play] resource ended immediately, switching to yt-dlp');
            const res = await ytDlpToPcmResource(built.display);
            ctx.player.play(res);
        } else {
            throw e;
        }
    }

    built.resource.playStream?.on?.('error', err => console.error('[Stream error]', err));

    let title = built.display;
    try { title = await fetchTitleWithTimeout(built.display, 1500); } catch { }
    ctx.now.title = title;
    printNowPlaying(title);
    if (announce) await announceNowPlaying(client, ctx);
}

// ================ Bot setup & commands ================
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

            const urls = await expandToUrls(inputUrl);
            const firstTitlesCount = Math.min(urls.length, 10);
            const titles = await Promise.all(urls.slice(0, firstTitlesCount).map(u => fetchTitle(u)));
            const items = urls.map((u, idx) => ({ url: u, title: idx < firstTitlesCount ? titles[idx] : undefined }));
            ctx.queue.push(...items);

            if (!ctx.now && ctx.queue.length > 0 && ctx.player.state.status !== AudioPlayerStatus.Playing) {
                const first = ctx.queue.shift();
                await playOne(ctx, first.url, { announce: true });
                return interaction.editReply(`➕ Thêm **${urls.length}** mục. 🎵 Đang phát: ${ctx.now?.title || ctx.now?.url}`);
            }
            return interaction.editReply(`➕ Đã thêm **${urls.length}** mục vào hàng đợi. Hiện đang phát: ${ctx.now?.title ?? ctx.now?.url ?? '—'}`);
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
        const slice = ctx.queue.slice(startIndex, startIndex + perPage);

        await Promise.all(slice.map(async (item) => {
            if (!item.title) item.title = await fetchTitle(item.url);
        }));

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
