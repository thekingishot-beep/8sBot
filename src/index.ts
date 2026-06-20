import { Client, GatewayIntentBits, Events, Interaction } from 'discord.js';
import * as dotenv from 'dotenv';
dotenv.config();

import { handleJoin }        from './commands/join';
import { handleLeave }       from './commands/leave';
import { handleStatus }      from './commands/status';
import { handleStats }       from './commands/stats';
import { handleLeaderboard } from './commands/leaderboard';
import { handleSetup }       from './commands/setup';
import {
  handleTeamVoteButton,
  handleMapVoteButton,
  handleResultButton,
} from './queueFlow';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ 8sBot online as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  // ── Slash commands ──
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;
    try {
      if (commandName === 'join')         return await handleJoin(interaction);
      if (commandName === 'leave')        return await handleLeave(interaction);
      if (commandName === 'queue')        return await handleStatus(interaction);
      if (commandName === 'stats')        return await handleStats(interaction);
      if (commandName === 'leaderboard')  return await handleLeaderboard(interaction);
      if (commandName === '8s-setup')     return await handleSetup(interaction);
    } catch (err) {
      console.error(`Error in /${commandName}:`, err);
      const msg = { content: '❌ Something went wrong. Try again.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    }
    return;
  }

  // ── Button interactions ──
  if (interaction.isButton()) {
    const { customId } = interaction;
    try {
      if (customId.startsWith('teamvote_')) {
        const choice = customId.replace('teamvote_', '') as 'random' | 'captains' | 'balanced';
        return await handleTeamVoteButton(interaction, choice);
      }
      if (customId.startsWith('mapvote_')) {
        const mapId = customId.replace('mapvote_', '');
        return await handleMapVoteButton(interaction, mapId);
      }
      if (customId === 'result_1') return await handleResultButton(interaction, 1);
      if (customId === 'result_2') return await handleResultButton(interaction, 2);
    } catch (err) {
      console.error(`Error in button ${customId}:`, err);
    }
    return;
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
