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
    .setDescription('Show the MMR leaderboard'),

  new SlashCommandBuilder()
    .setName('8s-setup')
    .setDescription('Configure a channel for 8sBot (Admin only)'),

  new SlashCommandBuilder()
    .setName('8s-remove')
    .setDescription('Remove 8sBot configuration from this channel (Admin only)'),

  new SlashCommandBuilder()
    .setName('8s-config')
    .setDescription('Configure 8sBot settings (Admin only)')
    .addSubcommand(sub =>
      sub.setName('ping-role')
        .setDescription('Role to ping when 1 queue spot remains')
        .addRoleOption(opt => opt.setName('role').setDescription('Role to ping (omit to clear)').setRequired(false))
        .addChannelOption(opt => opt.setName('channel').setDescription('Queue channel (defaults to current)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('rank-roles-add')
        .setDescription('Add/update an MMR rank role')
        .addIntegerOption(opt => opt.setName('min_mmr').setDescription('Minimum MMR to earn this role').setRequired(true))
        .addRoleOption(opt => opt.setName('role').setDescription('Discord role to assign').setRequired(true))
        .addStringOption(opt => opt.setName('label').setDescription('Display name (e.g. Gold)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('rank-roles-remove')
        .setDescription('Remove a rank role threshold')
        .addRoleOption(opt => opt.setName('role').setDescription('Role to remove').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('rank-roles-list')
        .setDescription('List all configured rank roles')
    )
    .addSubcommand(sub =>
      sub.setName('rank-roles-clear')
        .setDescription('Clear all rank role thresholds')
    ),

  new SlashCommandBuilder()
    .setName('mmr-set')
    .setDescription('Manually set a player\'s MMR (Admin only)')
    .addUserOption(opt => opt.setName('player').setDescription('Player to adjust').setRequired(true))
    .addIntegerOption(opt => opt.setName('mmr').setDescription('New MMR value').setRequired(true)),

  new SlashCommandBuilder()
    .setName('void-match')
    .setDescription('Void a match result and revert MMR (Admin only)')
    .addIntegerOption(opt => opt.setName('match_number').setDescription('Match number to void').setRequired(true)),

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
