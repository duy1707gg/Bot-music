import {
    AudioPlayerStatus,
    createAudioPlayer, createAudioResource,
    getVoiceConnection,
    joinVoiceChannel,
    NoSubscriberBehavior,
    StreamType,
} from '@discordjs/voice';
import ytdl from '@distube/ytdl-core';
import {
    ChannelType,
    Client, Events, GatewayIntentBits,
    MessageFlags, // 👈 dùng để gửi tin nhắn im lặng
} from 'discord.js';
import 'dotenv/config';
import play from 'play-dl';
import SpotifyWebApi from 'spotify-web-api-node';

// Nếu từng gặp lỗi FFmpeg not found, mở 2 dòng dưới (hoặc gán path ffmpeg thủ công):
// import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
// process.env.FFMPEG_PATH = ffmpegInstaller.path; // hoặc: 'C:\\ffmpeg\\bin\\ffmpeg.exe'

// ================= Helpers: YouTube search matcher =================
function parseDurationStr(s) {
    if (!s) return null;
    const parts = s.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    let sec = 0;
    for (let i = 0; i < parts.length; i++) sec = sec * 60 + parts[i];
    return sec;
}
function normalize(str) {
    return (str || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function titleLooksBad(title) {
    const t = normalize(title);
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

    const t = normalize(title);
    const wantTokens = (normalize(want.track) + ' ' + normalize(want.artist)).split(' ').filter(Boolean);
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

// ================= Helpers: YouTube (playlist → 1 video) =================
function getYTParams(raw) {
    try {
        const u = new URL(raw);
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
async function resolveYouTubePlayableUrl(rawUrl) {
    const { v, list, index, cleanVideoUrl } = getYTParams(rawUrl);
    if (v) return cleanVideoUrl(v);
    if (list) {
        const pl = await play.playlist_info(rawUrl, { incomplete: true });
        const videos = await pl.all_videos();
        const i = index && index > 0 ? index - 1 : 0;
        const chosen = videos[i] || videos[0];
        if (!chosen) throw new Error('Playlist trống hoặc không lấy được video.');
        return chosen.url;
    }
    return rawUrl;
}

// ================= Helpers: Spotify (Web API) =================
const spotify = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
});
let spotifyTokenExpiry = 0;
async function ensureSpotifyToken() {
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

    await ensureSpotifyToken();

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
            const info = await ytdl.getBasicInfo(url);
            return info?.videoDetails?.title || url;
        }
        if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
            const info = await play.video_basic_info(url).catch(() => null);
            return info?.video_details?.title || url;
        }
    } catch (_) { }
    return url;
}
async function fetchTitleWithTimeout(url, ms = 2000) {
    return await Promise.race([
        (async () => await fetchTitle(url))(),
        new Promise(resolve => setTimeout(() => resolve(url), ms))
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
async function createResourceFromUrl(urlInput) {
    let finalUrl = urlInput;

    // YouTube → chuẩn hoá
    if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(urlInput)) {
        finalUrl = await resolveYouTubePlayableUrl(urlInput);
    }

    // Spotify → đổi sang YouTube (nếu playlist/album: lấy bài đầu để phát ngay)
    if (/^(https?:\/\/)?open\.spotify\.com\//i.test(urlInput)) {
        const ytUrls = await resolveSpotifyToYoutubeUrls(urlInput);
        finalUrl = ytUrls[0];
    }

    // YouTube stream bằng ytdl
    if (ytdl.validateURL(finalUrl)) {
        const ytStream = ytdl(finalUrl, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25,
        });
        return {
            resource: createAudioResource(ytStream, { inputType: StreamType.Arbitrary, inlineVolume: true }),
            display: finalUrl,
        };
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

// Mở rộng URL thành danh sách (playlist YouTube/Spotify)
async function expandToUrls(rawUrl) {
    // YouTube
    if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(rawUrl)) {
        const { v, list } = getYTParams(rawUrl);
        if (v && !list) return [rawUrl];
        if (list) {
            const pl = await play.playlist_info(rawUrl, { incomplete: true });
            const vids = await pl.all_videos();
            return vids.map(v => v.url);
        }
    }
    // Spotify
    if (/^(https?:\/\/)?open\.spotify\.com\//i.test(rawUrl)) {
        return await resolveSpotifyToYoutubeUrls(rawUrl);
    }
    // Nguồn khác
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
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
        });

        connection.subscribe(player);

        ctx = { player, connection, queue: [], now: null, textChannelId: undefined };
        contexts.set(guild.id, ctx);

        // Khi hết bài → phát tiếp từ queue (announce lên kênh nhưng im lặng)
        player.on(AudioPlayerStatus.Idle, async () => {
            try {
                if (ctx.queue.length > 0) {
                    const next = ctx.queue.shift();
                    await playOne(ctx, next.url, { announce: true }); // 👈 vẫn announce nhưng sẽ suppress notifications
                } else {
                    ctx.now = null;
                }
            } catch (e) {
                console.error('[AUTO-NEXT] error:', e);
                ctx.now = null;
            }
        });

        player.on('error', (err) => console.error('[PLAYER] error:', err));

        // Log khi player thực sự vào trạng thái Playing
        player.on(AudioPlayerStatus.Playing, () => {
            const titleOrUrl = ctx.now?.title || ctx.now?.url || '(unknown)';
            printNowPlaying(titleOrUrl);
        });
    }
    return ctx;
}

async function announceNowPlaying(client, ctx) {
    try {
        if (!ctx.textChannelId || !ctx.now) return;
        const ch = await client.channels.fetch(ctx.textChannelId).catch(() => null);
        if (!ch || !('send' in ch)) return;
        const title = ctx.now.title || ctx.now.url;

        // 👇 gửi tin nhắn im lặng (không ting)
        await ch.send({
            content: `🎶 **Now Playing:** ${title}`,
            flags: MessageFlags.SuppressNotifications,
        });
    } catch (e) {
        console.error('[ANNOUNCE] error:', e);
    }
}

async function playOne(ctx, url, { announce = false } = {}) {
    const { resource, display } = await createResourceFromUrl(url);

    // gắn trước để listener Playing đọc được
    ctx.now = { url: display, title: undefined };

    // phát trước
    ctx.player.play(resource);

    // lấy tiêu đề có timeout (2s), nếu fail dùng URL
    let title = display;
    try {
        title = await fetchTitleWithTimeout(display, 2000);
    } catch (_) { /* ignore */ }
    ctx.now.title = title;

    // in ra console một dòng chuẩn
    printNowPlaying(title);

    // gửi thông báo (im lặng) nếu announce=true
    if (announce) {
        await announceNowPlaying(client, ctx);
    }
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
            ctx.textChannelId = interaction.channelId; // nhớ kênh
            if (ctx.connection.joinConfig.channelId !== voiceChannel.id) {
                ctx.connection.destroy();
                contexts.delete(guild.id);
                ctx = getOrCreate(guild, voiceChannel);
                ctx.textChannelId = interaction.channelId;
            }

            ctx.queue.length = 0; // clear queue
            await playOne(ctx, inputUrl, { announce: true }); // 👈 bật announce (im lặng)
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

            // lấy sẵn tiêu đề cho 10 bài đầu để hiển thị đẹp
            const firstTitlesCount = Math.min(urls.length, 10);
            const titles = await Promise.all(urls.slice(0, firstTitlesCount).map(u => fetchTitle(u)));
            const items = urls.map((u, idx) => ({ url: u, title: idx < firstTitlesCount ? titles[idx] : undefined }));

            ctx.queue.push(...items);

            if (!ctx.now && ctx.queue.length > 0 && ctx.player.state.status !== AudioPlayerStatus.Playing) {
                const first = ctx.queue.shift();
                await playOne(ctx, first.url, { announce: true }); // 👈 bật announce (im lặng)
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
        ctx.player.stop(true); // sẽ kích hoạt Idle và tự next (announce im lặng)
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
