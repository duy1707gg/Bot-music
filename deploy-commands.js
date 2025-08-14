import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import 'dotenv/config';

const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Phát ngay một URL (YouTube/mp3/Spotify track)')
        .addStringOption(o => o.setName('url').setDescription('URL âm thanh / video').setRequired(true)),

    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Thêm vào hàng đợi (hỗ trợ cả playlist YouTube/Spotify)')
        .addStringOption(o => o.setName('url').setDescription('URL video/playlist/track').setRequired(true)),

    new SlashCommandBuilder().setName('skip').setDescription('Bỏ qua bài hiện tại'),
    new SlashCommandBuilder().setName('pause').setDescription('Tạm dừng'),
    new SlashCommandBuilder().setName('resume').setDescription('Tiếp tục phát'),
    new SlashCommandBuilder().setName('nowplaying').setDescription('Xem bài đang phát'),
    new SlashCommandBuilder().setName('stop').setDescription('Dừng phát (xoá queue)'),
    new SlashCommandBuilder().setName('leave').setDescription('Rời voice channel'),
    new SlashCommandBuilder().setName('shuffle').setDescription('Xáo trộn hàng đợi'),
    new SlashCommandBuilder()
        .setName('queue_list')
        .setDescription('Xem danh sách bài trong hàng đợi')
        .addIntegerOption(o =>
            o.setName('page').setDescription('Trang (mỗi trang 10 bài, mặc định 1)').setMinValue(1)
        ),

    // ✅ Thêm mới: /loop.
    new SlashCommandBuilder()
        .setName('loop')
        .setDescription('Bật/tắt loop')
        .addStringOption(o =>
            o
                .setName('mode')
                .setDescription('none | one | all')
                .setRequired(true)
                .addChoices(
                    { name: 'none', value: 'none' },
                    { name: 'one', value: 'one' },
                    { name: 'all', value: 'all' },
                )
        ),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Slash commands deployed');
} catch (e) {
    console.error(e);
}
