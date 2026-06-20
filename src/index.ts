import { Client, GatewayIntentBits, Events, Interaction } from 'discord.js';
import * as dotenv from 'dotenv';
dotenv.config();

import { handleJoin }        from './commands/join';
import { handleLeave }       from './commands/leave';
import { handleStatus }      from './commands/status';
import { handleStats }       from './commands/stats';
import { handleLeaderboard, handleLeaderboardButton, handleLeaderboardTypeSelect } from './commands/leaderboard';
import {
  handleTeamVoteButton,
  handleMmrVoteButton,
  handleMapVoteButton,
  handleResultButton,
  handleJoinButton,
  handleLeaveButton,
  handleForceStart,
  handleCancelQueue,
} from './queueFlow';
import { handleCaptainPickButton } from './captainFlow';
import {
  handleSetupCommand,
  handleSetupChannelSelect,
  handleSetupResultsChannelSelect,
  handleSetupGameSelect,
  handleSetupSizeSelect,
  handleSetupSave,
  handleSetupCancel,
} from './setupFlow';
import { handleRemoveCommand } from './removeFlow';

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

  // ── Slash commands ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;
    try {
      if (commandName === 'join')        return await handleJoin(interaction);
      if (commandName === 'leave')       return await handleLeave(interaction);
      if (commandName === 'queue')       return await handleStatus(interaction);
      if (commandName === 'stats')       return await handleStats(interaction);
      if (commandName === 'leaderboard') return await handleLeaderboard(interaction);
      if (commandName === '8s-setup')    return await handleSetupCommand(interaction);
      if (commandName === '8s-remove')   return await handleRemoveCommand(interaction);
    } catch (err) {
      console.error(`Error in /${commandName}:`, err);
      const msg = { content: '❌ Something went wrong. Try again.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    }
    return;
  }

  // ── Select menus ────────────────────────────────────────────────────────────
  if (interaction.isChannelSelectMenu()) {
    if (interaction.customId === 'setup_channel')         return await handleSetupChannelSelect(interaction);
    if (interaction.customId === 'setup_results_channel') return await handleSetupResultsChannelSelect(interaction);
    return;
  }

  if (interaction.isStringSelectMenu()) {
    try {
      if (interaction.customId === 'setup_game')          return await handleSetupGameSelect(interaction);
      if (interaction.customId === 'setup_size')          return await handleSetupSizeSelect(interaction);
      if (interaction.customId.startsWith('lb_type_'))    return await handleLeaderboardTypeSelect(interaction);
    } catch (err) {
      console.error(`Error in select ${interaction.customId}:`, err);
    }
    return;
  }

  // ── Buttons ─────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const { customId } = interaction;
    try {
      // Setup flow
      if (customId === 'setup_save')   return await handleSetupSave(interaction);
      if (customId === 'setup_cancel') return await handleSetupCancel(interaction);

      // Queue join/leave/admin
      if (customId === 'queue_join')         return await handleJoinButton(interaction);
      if (customId === 'queue_leave')        return await handleLeaveButton(interaction);
      if (customId === 'queue_force_start')  return await handleForceStart(interaction);
      if (customId === 'queue_cancel')       return await handleCancelQueue(interaction);

      // Team vote
      if (customId.startsWith('teamvote_')) {
        const choice = customId.replace('teamvote_', '') as 'random' | 'captains' | 'balanced' | 'unfair';
        return await handleTeamVoteButton(interaction, choice);
      }

      // MMR vote
      if (customId.startsWith('mmrvote_')) {
        const choice = customId.replace('mmrvote_', '') as 'enable' | 'disable';
        return await handleMmrVoteButton(interaction, choice);
      }

      // Map vote
      if (customId.startsWith('mapvote_')) {
        const mapId = customId.replace('mapvote_', '');
        return await handleMapVoteButton(interaction, mapId);
      }

      // Captain pick
      if (customId.startsWith('captain_pick_')) {
        const pickedId = customId.replace('captain_pick_', '');
        return await handleCaptainPickButton(interaction, pickedId);
      }

      // Result vote
      if (customId === 'result_1') return await handleResultButton(interaction, 1);
      if (customId === 'result_2') return await handleResultButton(interaction, 2);

      // Leaderboard pagination
      if (customId.startsWith('lb_prev_') || customId.startsWith('lb_next_') ||
          customId.startsWith('lb_first_') || customId.startsWith('lb_last_')) {
        return await handleLeaderboardButton(interaction);
      }

    } catch (err) {
      console.error(`Error in button ${customId}:`, err);
    }
    return;
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
