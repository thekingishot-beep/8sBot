import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import * as dotenv from 'dotenv';
dotenv.config();

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join the 8s queue in this channel'),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the current queue'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show who is currently in the queue'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View 8sBot stats for a player')
    .addUserOption(opt =>
      opt.setName('player').setDescription('Player to look up (defaults to yourself)').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top 10 players by win rate'),

  new SlashCommandBuilder()
    .setName('8s-setup')
    .setDescription('Configure a channel for 8sBot (Admin only)'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID!, process.env.DISCORD_GUILD_ID!),
      { body: commands }
    );
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
})();
