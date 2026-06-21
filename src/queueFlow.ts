import {
  ButtonInteraction,
  Message,
  TextChannel,
  VoiceChannel,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
} from 'discord.js';
import { supabase } from './supabase';
import { getMapPool, pickBo5Maps, Bo5Map } from './mapPool';
import {
  buildQueueEmbed,
  buildTeamVoteEmbed,
  buildMatchEmbed,
  buildWinnerEmbed,
} from './queueEmbed';
import {
  getMmrMap,
  applyMmrAfterMatch,
  splitBalanced,
  splitUnfair,
  touchMmrRow,
  MMR_START,
} from './mmr';
import { startCaptainDraft } from './captainFlow';
import { startVcPhase } from './vcFlow';

const TEAM_VOTE_SECONDS  = 30;
const FIRST_JOIN_MINUTES = 15;

// ─── Inactivity timer map ─────────────────────────────────────────────────────
const inactivityTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── First-join timer map (15-min hard deadline) ──────────────────────────────
const firstJoinTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearFirstJoinTimer(queueId: string) {
  const handle = firstJoinTimers.get(queueId);
  if (handle) { clearTimeout(handle); firstJoinTimers.delete(queueId); }
}

function startFirstJoinTimerForQueue(params: {
  queueId:           string;
  channelId:         string;
  guildId:           string;
  gameId:            string;
  teamSize:          number;
  displayName:       string;
  mmrEnabled:        boolean;
  inactivityMinutes: number;
  client:            any;
  currentMsgId:      string | null;
}) {
  const { queueId, channelId, guildId, gameId, teamSize, displayName, mmrEnabled, inactivityMinutes, client, currentMsgId } = params;
  clearFirstJoinTimer(queueId);

  const handle = setTimeout(async () => {
    firstJoinTimers.delete(queueId);
    const { data: q } = await supabase.from('eights_queues').select('status, message_id').eq('id', queueId).single();
    if (!q || q.status !== 'waiting') return;

    await supabase.from('eights_queues').update({ status: 'cancelled' }).eq('id', queueId);
    await supabase.from('eights_queue_players').delete().eq('queue_id', queueId);
    if (inactivityTimers.has(queueId)) { clearTimeout(inactivityTimers.get(queueId)!); inactivityTimers.delete(queueId); }

    try {
      const ch = await client.channels.fetch(channelId) as TextChannel;
      const msgId = q.message_id || currentMsgId;
      if (msgId) {
        const old = await ch.messages.fetch(msgId).catch(() => null);
        if (old) await old.edit({ content: `⌛ Queue expired — no match found in ${FIRST_JOIN_MINUTES} minutes.`, embeds: [], components: [] }).catch(() => {});
      }
      const { data: newQ } = await supabase.from('eights_queues').insert({
        guild_id: guildId, channel_id: channelId, game_id: gameId, team_size: teamSize, status: 'waiting',
      }).select('id').single();
      if (newQ) {
        const freshMsgId = await refreshQueueEmbed(ch, newQ.id, teamSize, displayName, mmrEnabled, null, inactivityMinutes);
        if (freshMsgId) await supabase.from('eights_queues').update({ message_id: freshMsgId }).eq('id', newQ.id);
      }
    } catch (err) { console.error('[firstJoinTimer] Error resetting queue:', err); }
  }, FIRST_JOIN_MINUTES * 60 * 1000);

  firstJoinTimers.set(queueId, handle);
}

function resetInactivityTimer(queueId: string, channelId: string, messageId: string | null, inactivityMinutes: number, channel: any) {
  if (inactivityTimers.has(queueId)) clearTimeout(inactivityTimers.get(queueId)!);

  const timer = setTimeout(async () => {
    inactivityTimers.delete(queueId);

    const { data: queue } = await supabase.from('eights_queues').select('status').eq('id', queueId).single();
    if (!queue || queue.status !== 'waiting') return;

    await supabase.from('eights_queues').update({ status: 'cancelled' }).eq('id', queueId);

    if (messageId) {
      try {
        const msg = await channel.messages.fetch(messageId);
        await msg.edit({
          content: `⏱️ **Queue emptied due to ${inactivityMinutes} minutes of inactivity.**\nRe-enter the queue if you are still looking to play!`,
          embeds: [],
          components: [],
        });
      } catch { /* message gone */ }
    }
  }, inactivityMinutes * 60 * 1000);

  inactivityTimers.set(queueId, timer);
}

function isStaff(interaction: ButtonInteraction, staffRoleId: string | null): boolean {
  const member = interaction.member as any;
  if (member?.permissions?.has?.('ManageChannels')) return true;
  if (staffRoleId && member?.roles?.cache?.has?.(staffRoleId)) return true;
  return false;
}

// ─── Shared helper: refresh the queue embed in the channel ───────────────────

export async function refreshQueueEmbed(
  channel: any,
  queueId: string,
  teamSize: number,
  gameName: string,
  mmrEnabled: boolean,
  existingMessageId?: string | null,
  inactivityMinutes?: number
): Promise<string | null> {
  const { data: players } = await supabase
    .from('eights_queue_players')
    .select('discord_id, mmr_at_queue_time')
    .eq('queue_id', queueId);

  const playerList = (players || []).map(p => ({
    tag: `<@${p.discord_id}>`,
    mmr: p.mmr_at_queue_time,
  }));

  const { embed, row } = buildQueueEmbed(playerList, teamSize, gameName, mmrEnabled);

  let msgId: string | null = null;
  if (existingMessageId) {
    try {
      const msg = await channel.messages.fetch(existingMessageId);
      await msg.edit({ embeds: [embed], components: [row] });
      msgId = existingMessageId;
    } catch { /* message deleted — fall through to send */ }
  }

  if (!msgId) {
    const msg = await channel.send({ embeds: [embed], components: [row] });
    msgId = msg.id;
  }

  if (inactivityMinutes && inactivityMinutes > 0) {
    resetInactivityTimer(queueId, channel.id, msgId, inactivityMinutes, channel);
  }

  return msgId;
}

// ─── Queue full — create private match channel, new queue, post team vote ────

export async function handleQueueFull(
  channel: any,           // main queue TextChannel
  queueId: string,
  teamSize: number,
  gameName: string,
  mmrEnabled: boolean,
  existingMessageId: string | null
) {
  if (inactivityTimers.has(queueId)) {
    clearTimeout(inactivityTimers.get(queueId)!);
    inactivityTimers.delete(queueId);
  }
  clearFirstJoinTimer(queueId);

  await supabase.from('eights_queues').update({ status: 'voting_teams' }).eq('id', queueId);

  const guild   = (channel as TextChannel).guild;
  const guildId = guild.id;

  // Fetch config
  const { data: config } = await supabase
    .from('eights_channel_config')
    .select('staff_role_id, lobby_vc_id, game_id, inactivity_minutes')
    .eq('guild_id', guildId)
    .eq('channel_id', (channel as TextChannel).id)
    .single();

  // Fetch players
  const { data: players } = await supabase
    .from('eights_queue_players')
    .select('discord_id')
    .eq('queue_id', queueId);
  const playerIds = (players || []).map(p => p.discord_id as string);

  // Pre-calculate match number
  const { count: matchCount } = await supabase
    .from('eights_matches')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', guildId);
  const matchNumber = (matchCount || 0) + 1;

  // Determine category for the private channel (from lobby VC or queue channel itself)
  let categoryId: string | null = null;
  const lobbyVcId = config?.lobby_vc_id ?? null;
  if (lobbyVcId) {
    const lobbyVc = guild.channels.cache.get(lobbyVcId);
    if (lobbyVc?.parentId) categoryId = lobbyVc.parentId;
  }
  if (!categoryId) {
    const queueCh = guild.channels.cache.get((channel as TextChannel).id);
    if (queueCh?.parentId) categoryId = queueCh.parentId;
  }

  // Build permission overwrites for the private channel
  const staffRoleId = config?.staff_role_id ?? null;
  const permOverwrites: any[] = [
    {
      id:   guildId,
      type: OverwriteType.Role,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    ...playerIds.map(id => ({
      id,
      type:  OverwriteType.Member,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    })),
  ];
  if (staffRoleId) {
    permOverwrites.push({
      id:    staffRoleId,
      type:  OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  // Create private text channel (fall back to main channel if bot lacks permission)
  let privateChannel: TextChannel = channel;
  try {
    privateChannel = await guild.channels.create({
      name:                 `match-${matchNumber}`,
      type:                 ChannelType.GuildText,
      parent:               categoryId || undefined,
      permissionOverwrites: permOverwrites,
    }) as TextChannel;
  } catch (err) {
    console.error('[queueFlow] Failed to create private match channel:', err);
  }

  // Edit main channel embed to show match in progress (no buttons)
  if (existingMessageId) {
    try {
      const old = await channel.messages.fetch(existingMessageId);
      await old.edit({
        content:    `⚔️ **Match #${matchNumber} is in progress**`,
        embeds:     [],
        components: [],
      });
    } catch {}
  }

  // Create a fresh empty queue in the main channel so others can queue
  const { data: origQueue } = await supabase
    .from('eights_queues')
    .select('game_id')
    .eq('id', queueId)
    .single();

  const { data: newQueue } = await supabase
    .from('eights_queues')
    .insert({
      guild_id:   guildId,
      channel_id: (channel as TextChannel).id,
      game_id:    origQueue?.game_id ?? config?.game_id,
      team_size:  teamSize,
      status:     'waiting',
    })
    .select('id')
    .single();

  if (newQueue) {
    const newMsgId = await refreshQueueEmbed(
      channel, newQueue.id, teamSize, gameName, mmrEnabled, null,
      config?.inactivity_minutes ?? 60
    );
    if (newMsgId) {
      await supabase.from('eights_queues').update({ message_id: newMsgId }).eq('id', newQueue.id);
    }
  }

  // Post team vote in the private channel, @mentioning all 8 players
  const mentions = playerIds.map(id => `<@${id}>`).join(' ');
  const { embed, rows } = buildTeamVoteEmbed(queueId, {}, {});

  const voteMsg = await privateChannel.send({
    content:    `${mentions}\n\nQueue is full! Vote for team selection — **${TEAM_VOTE_SECONDS}s**`,
    embeds:     [embed],
    components: rows,
  });

  await supabase.from('eights_queues').update({ message_id: voteMsg.id }).eq('id', queueId);

  setTimeout(() => resolveTeamVote(queueId, teamSize, gameName, mmrEnabled, voteMsg), TEAM_VOTE_SECONDS * 1000);
}

// ─── Join via button ──────────────────────────────────────────────────────────

export async function handleJoinButton(interaction: ButtonInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const guildId   = interaction.guildId!;
  const channelId = interaction.channelId;
  const discordId = interaction.user.id;

  const { data: config } = await supabase
    .from('eights_channel_config')
    .select('*')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .single();

  if (!config) return interaction.editReply({ content: '❌ This channel is not configured for 8sBot.' });

  let { data: queue } = await supabase
    .from('eights_queues')
    .select('*')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .eq('status', 'waiting')
    .single();

  if (!queue) {
    const { data: newQueue } = await supabase
      .from('eights_queues')
      .insert({ guild_id: guildId, channel_id: channelId, game_id: config.game_id, team_size: config.team_size, status: 'waiting' })
      .select().single();
    if (!newQueue) return interaction.editReply({ content: '❌ Failed to create queue.' });
    queue = newQueue;
  }

  const { data: existing } = await supabase
    .from('eights_queue_players')
    .select('id').eq('queue_id', queue.id).eq('discord_id', discordId).single();

  if (existing) return interaction.editReply({ content: '⚠️ You\'re already in the queue.' });

  const { data: profile } = await supabase
    .from('profiles').select('id').eq('discord_id', discordId).single();

  const mmr = await touchMmrRow(discordId, guildId, interaction.user.username);

  await supabase.from('eights_queue_players').insert({
    queue_id:          queue.id,
    discord_id:        discordId,
    profile_id:        profile?.id ?? null,
    mmr_at_queue_time: mmr,
  });

  const { data: gameName } = await supabase.from('games').select('name').eq('id', config.game_id).single();

  const total = config.team_size * 2;
  const { data: players } = await supabase
    .from('eights_queue_players').select('discord_id').eq('queue_id', queue.id);
  const count = (players || []).length;

  const displayName = config.queue_name || gameName?.name || 'Queue';
  const ch          = interaction.channel as TextChannel;
  const newMsgId    = await refreshQueueEmbed(ch, queue.id, config.team_size, displayName, config.mmr_enabled, queue.message_id, config.inactivity_minutes ?? 60);
  if (newMsgId && newMsgId !== queue.message_id) {
    await supabase.from('eights_queues').update({ message_id: newMsgId }).eq('id', queue.id);
  }

  await interaction.editReply({ content: `✅ You joined the queue! [${count}/${total}]` });

  if (count === 1) {
    startFirstJoinTimerForQueue({
      queueId:           queue.id,
      channelId,
      guildId,
      gameId:            config.game_id,
      teamSize:          config.team_size,
      displayName,
      mmrEnabled:        config.mmr_enabled,
      inactivityMinutes: config.inactivity_minutes ?? 60,
      client:            interaction.client,
      currentMsgId:      newMsgId || queue.message_id,
    });
  }

  if (count >= total) {
    await handleQueueFull(ch, queue.id, config.team_size, displayName, config.mmr_enabled, newMsgId || queue.message_id);
  }
}

// ─── Leave via button ─────────────────────────────────────────────────────────

export async function handleLeaveButton(interaction: ButtonInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const { data: queue } = await supabase
    .from('eights_queues').select('*')
    .eq('guild_id', interaction.guildId!)
    .eq('channel_id', interaction.channelId)
    .eq('status', 'waiting')
    .single();

  if (!queue) return interaction.editReply({ content: '❌ No active queue in this channel.' });

  const { data: existing } = await supabase
    .from('eights_queue_players').select('id')
    .eq('queue_id', queue.id).eq('discord_id', interaction.user.id).single();

  if (!existing) return interaction.editReply({ content: '⚠️ You\'re not in the queue.' });

  await supabase.from('eights_queue_players').delete().eq('id', existing.id);

  const { data: gameName } = await supabase.from('games').select('name').eq('id', queue.game_id).single();
  const { data: config }   = await supabase.from('eights_channel_config').select('mmr_enabled, inactivity_minutes')
    .eq('guild_id', interaction.guildId!).eq('channel_id', interaction.channelId).single();

  const ch = interaction.channel as TextChannel;
  await refreshQueueEmbed(ch, queue.id, queue.team_size, gameName?.name || 'Queue', config?.mmr_enabled ?? true, queue.message_id, config?.inactivity_minutes ?? 60);

  await interaction.editReply({ content: '✅ You left the queue.' });
}

// ─── Force start (admin only) ─────────────────────────────────────────────────

export async function handleForceStart(interaction: ButtonInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const { data: cfg } = await supabase.from('eights_channel_config').select('staff_role_id')
    .eq('guild_id', interaction.guildId!).eq('channel_id', interaction.channelId).single();
  if (!isStaff(interaction, cfg?.staff_role_id ?? null)) {
    return interaction.editReply({ content: '❌ Only staff can force start.' });
  }

  const { data: queue } = await supabase
    .from('eights_queues').select('*')
    .eq('guild_id', interaction.guildId!)
    .eq('channel_id', interaction.channelId)
    .eq('status', 'waiting')
    .single();

  if (!queue) return interaction.editReply({ content: '❌ No waiting queue to force start.' });

  const { data: players } = await supabase
    .from('eights_queue_players').select('discord_id').eq('queue_id', queue.id);

  if (!players || players.length < 2) {
    return interaction.editReply({ content: '❌ Need at least 2 players to force start.' });
  }

  const { data: config }   = await supabase.from('eights_channel_config').select('*')
    .eq('guild_id', interaction.guildId!).eq('channel_id', interaction.channelId).single();
  const { data: gameName } = await supabase.from('games').select('name').eq('id', queue.game_id).single();

  await interaction.editReply({ content: '✅ Force starting queue...' });
  await handleQueueFull(interaction.channel as TextChannel, queue.id, queue.team_size, gameName?.name || 'Queue', config?.mmr_enabled ?? true, queue.message_id);
}

// ─── Cancel queue (admin only) ────────────────────────────────────────────────

export async function handleCancelQueue(interaction: ButtonInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const { data: cfg } = await supabase.from('eights_channel_config').select('staff_role_id')
    .eq('guild_id', interaction.guildId!).eq('channel_id', interaction.channelId).single();
  if (!isStaff(interaction, cfg?.staff_role_id ?? null)) {
    return interaction.editReply({ content: '❌ Only staff can cancel the queue.' });
  }

  const { data: queue } = await supabase
    .from('eights_queues').select('*')
    .eq('guild_id', interaction.guildId!)
    .eq('channel_id', interaction.channelId)
    .eq('status', 'waiting')
    .single();

  if (!queue) return interaction.editReply({ content: '❌ No waiting queue to cancel.' });

  await supabase.from('eights_queues').update({ status: 'cancelled' }).eq('id', queue.id);
  clearFirstJoinTimer(queue.id);
  if (inactivityTimers.has(queue.id)) {
    clearTimeout(inactivityTimers.get(queue.id)!);
    inactivityTimers.delete(queue.id);
  }

  if (queue.message_id) {
    try {
      const msg = await (interaction.channel as TextChannel).messages.fetch(queue.message_id);
      await msg.edit({ content: '🚫 Queue cancelled by staff.', embeds: [], components: [] });
    } catch { /* message gone */ }
  }

  await interaction.editReply({ content: '✅ Queue cancelled.' });
}

// ─── Team vote buttons ────────────────────────────────────────────────────────

export async function handleTeamVoteButton(
  interaction: ButtonInteraction,
  choice: 'random' | 'captains' | 'balanced' | 'unfair',
  queueId: string
) {
  await interaction.deferUpdate();
  const discordId = interaction.user.id;

  const { data: queue } = await supabase
    .from('eights_queues').select('*')
    .eq('id', queueId)
    .eq('status', 'voting_teams')
    .single();

  if (!queue) return;

  const { data: player } = await supabase
    .from('eights_queue_players').select('id')
    .eq('queue_id', queue.id).eq('discord_id', discordId).single();

  if (!player) return interaction.followUp({ content: '❌ You\'re not in this queue.', ephemeral: true });

  const votes: Record<string, string[]> = queue.team_vote || {};
  for (const key of Object.keys(votes)) votes[key] = votes[key].filter((id: string) => id !== discordId);
  if (!votes[choice]) votes[choice] = [];
  votes[choice].push(discordId);

  await supabase.from('eights_queues').update({ team_vote: votes }).eq('id', queue.id);

  const mmrVotes: Record<string, string[]> = queue.mmr_vote || {};
  const { embed, rows } = buildTeamVoteEmbed(queue.id, votes, mmrVotes);
  await interaction.message.edit({ embeds: [embed], components: rows });

  await interaction.followUp({ content: `✅ Voted **${choice}**.`, ephemeral: true });
}

// ─── MMR vote buttons ─────────────────────────────────────────────────────────

export async function handleMmrVoteButton(
  interaction: ButtonInteraction,
  choice: 'enable' | 'disable',
  queueId: string
) {
  await interaction.deferUpdate();
  const discordId = interaction.user.id;

  const { data: queue } = await supabase
    .from('eights_queues').select('*')
    .eq('id', queueId)
    .eq('status', 'voting_teams')
    .single();

  if (!queue) return;

  const { data: player } = await supabase
    .from('eights_queue_players').select('id')
    .eq('queue_id', queue.id).eq('discord_id', discordId).single();

  if (!player) return interaction.followUp({ content: '❌ You\'re not in this queue.', ephemeral: true });

  const mmrVotes: Record<string, string[]> = queue.mmr_vote || {};
  for (const key of Object.keys(mmrVotes)) mmrVotes[key] = mmrVotes[key].filter((id: string) => id !== discordId);
  if (!mmrVotes[choice]) mmrVotes[choice] = [];
  mmrVotes[choice].push(discordId);

  await supabase.from('eights_queues').update({ mmr_vote: mmrVotes }).eq('id', queue.id);

  const teamVotes: Record<string, string[]> = queue.team_vote || {};
  const { embed, rows } = buildTeamVoteEmbed(queue.id, teamVotes, mmrVotes);
  await interaction.message.edit({ embeds: [embed], components: rows });

  await interaction.followUp({ content: `✅ MMR vote: **${choice}**.`, ephemeral: true });
}

// ─── Resolve team vote after timeout ─────────────────────────────────────────

async function resolveTeamVote(
  queueId: string,
  teamSize: number,
  gameName: string,
  mmrEnabledDefault: boolean,
  voteMsg: Message
) {
  const { data: queue } = await supabase.from('eights_queues').select('*').eq('id', queueId).single();
  if (!queue || queue.status !== 'voting_teams') return;

  const votes: Record<string, string[]> = queue.team_vote || {};
  const counts = {
    random:   (votes['random']   || []).length,
    captains: (votes['captains'] || []).length,
    balanced: (votes['balanced'] || []).length,
    unfair:   (votes['unfair']   || []).length,
  };
  const max = Math.max(...Object.values(counts));
  let winner: 'random' | 'captains' | 'balanced' | 'unfair' = 'random';
  if (max > 0) {
    if (counts.balanced === max)       winner = 'balanced';
    else if (counts.captains === max)  winner = 'captains';
    else if (counts.unfair === max)    winner = 'unfair';
  }

  const mmrVotes: Record<string, string[]> = queue.mmr_vote || {};
  const mmrEnabled = (mmrVotes['disable'] || []).length > (mmrVotes['enable'] || []).length
    ? false
    : mmrEnabledDefault;

  // Mark queue as in_progress to prevent late votes from firing again
  await supabase.from('eights_queues').update({
    status:                'in_progress',
    chosen_team_selection: winner,
  }).eq('id', queueId);

  const { data: players } = await supabase
    .from('eights_queue_players').select('discord_id, profile_id, mmr_at_queue_time')
    .eq('queue_id', queueId);

  if (!players) return;

  const mmrMap    = Object.fromEntries(players.map(p => [p.discord_id, p.mmr_at_queue_time ?? MMR_START]));
  const playerObjs = players.map(p => ({ discord_id: p.discord_id, profile_id: p.profile_id }));

  if (winner === 'captains') {
    await startCaptainDraft(queue, playerObjs, mmrEnabled, voteMsg.channel, voteMsg);
    return;
  }

  let team1: typeof playerObjs;
  let team2: typeof playerObjs;

  if (winner === 'balanced') {
    const split = splitBalanced(playerObjs, mmrMap);
    team1 = split.team1; team2 = split.team2;
  } else if (winner === 'unfair') {
    const split = splitUnfair(playerObjs, mmrMap);
    team1 = split.team1; team2 = split.team2;
  } else {
    const shuffled = [...playerObjs].sort(() => Math.random() - 0.5);
    const half = Math.ceil(shuffled.length / 2);
    team1 = shuffled.slice(0, half);
    team2 = shuffled.slice(half);
  }

  // Pick a random BO5 series (no vote)
  const pool    = await getMapPool(queue.game_id);
  const bo5Maps = pickBo5Maps(pool);

  await startMatchFromTeams(queueId, team1, team2, bo5Maps, winner, voteMsg);
}

// ─── Start match (shared entry point) ────────────────────────────────────────

export async function startMatchFromTeams(
  queueId: string,
  team1: Array<{ discord_id: string; profile_id: string | null }>,
  team2: Array<{ discord_id: string; profile_id: string | null }>,
  bo5Maps: Bo5Map[],
  teamSelection: string,
  voteMsg: Message,
  captain1Name?: string,
  captain2Name?: string
) {
  const { data: queue } = await supabase.from('eights_queues').select('*').eq('id', queueId).single();
  if (!queue) return;

  await supabase.from('eights_queues').update({
    status:      'in_progress',
    chosen_map:  bo5Maps[0]?.map  || 'TBD',
    chosen_mode: bo5Maps[0]?.mode || 'TBD',
  }).eq('id', queueId);

  const { count } = await supabase
    .from('eights_matches')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', queue.guild_id);
  const matchNumber = (count || 0) + 1;

  const { data: match } = await supabase.from('eights_matches').insert({
    queue_id:        queueId,
    guild_id:        queue.guild_id,
    channel_id:      queue.channel_id,
    game_id:         queue.game_id,
    map:             bo5Maps[0]?.map  || 'TBD',
    mode:            bo5Maps[0]?.mode || 'TBD',
    bo5_maps:        bo5Maps,
    team_selection:  teamSelection,
    status:          'in_progress',
    match_number:    matchNumber,
    text_channel_id: voteMsg.channelId,
  }).select().single();

  if (!match) return;

  const playerRows = [
    ...team1.map(p => ({ match_id: match.id, discord_id: p.discord_id, profile_id: p.profile_id, team: 1 })),
    ...team2.map(p => ({ match_id: match.id, discord_id: p.discord_id, profile_id: p.profile_id, team: 2 })),
  ];
  await supabase.from('eights_match_players').insert(playerRows);

  const team1Tags = team1.map(p => `<@${p.discord_id}>`);
  const team2Tags = team2.map(p => `<@${p.discord_id}>`);

  const { embed, row } = buildMatchEmbed(team1Tags, team2Tags, bo5Maps, teamSelection, matchNumber, captain1Name, captain2Name);
  await voteMsg.edit({ content: '⚔️ Match is live! GL HF', embeds: [embed], components: [row] });
  await supabase.from('eights_matches').update({ message_id: voteMsg.id }).eq('id', match.id);

  // ── VC Management ─────────────────────────────────────────────────────────
  const { data: vcConfig } = await supabase
    .from('eights_channel_config')
    .select('lobby_vc_id, vc_join_minutes, mmr_enabled, queue_name, inactivity_minutes, staff_role_id')
    .eq('guild_id', queue.guild_id).eq('channel_id', queue.channel_id).single();

  const vcJoinMinutes = vcConfig?.vc_join_minutes ?? 0;
  if (vcJoinMinutes > 0 && voteMsg.guild) {
    const { data: gameRow } = await supabase.from('games').select('name').eq('id', queue.game_id).single();
    const gameName        = vcConfig?.queue_name || gameRow?.name || 'Queue';
    const mmrEnabled      = vcConfig?.mmr_enabled ?? true;
    const teamSize        = queue.team_size as number;
    const inactivityMins  = vcConfig?.inactivity_minutes ?? 60;
    const vcClient        = voteMsg.client;
    const vcChannelId     = queue.channel_id as string;
    const vcGuildId       = queue.guild_id as string;
    const vcGameId        = queue.game_id as string;

    await startVcPhase({
      guild:                 voteMsg.guild,
      matchId:               match.id,
      queueId,
      queueChannelId:        vcChannelId,
      announcementChannelId: voteMsg.channelId,  // private match channel
      guildId:               vcGuildId,
      teamSize,
      gameName,
      mmrEnabled,
      gameId:                vcGameId,
      team1Ids:              team1.map(p => p.discord_id),
      team2Ids:              team2.map(p => p.discord_id),
      lobbyVcId:             vcConfig?.lobby_vc_id ?? null,
      staffRoleId:           vcConfig?.staff_role_id ?? null,
      vcJoinMinutes,
      onRequeue: async (newQueueId: string, presentIds: string[], ch: any) => {
        const msgId = await refreshQueueEmbed(ch, newQueueId, teamSize, gameName, mmrEnabled, null, inactivityMins);
        if (msgId) await supabase.from('eights_queues').update({ message_id: msgId }).eq('id', newQueueId);
        if (presentIds.length > 0) {
          startFirstJoinTimerForQueue({
            queueId:           newQueueId,
            channelId:         vcChannelId,
            guildId:           vcGuildId,
            gameId:            vcGameId,
            teamSize,
            displayName:       gameName,
            mmrEnabled,
            inactivityMinutes: inactivityMins,
            client:            vcClient,
            currentMsgId:      msgId,
          });
        }
      },
    });
  }
}

// ─── Result vote button ───────────────────────────────────────────────────────

export async function handleResultButton(interaction: ButtonInteraction, winnerTeam: 1 | 2) {
  await interaction.deferUpdate();
  const discordId = interaction.user.id;

  const { data: match } = await supabase
    .from('eights_matches').select('*')
    .eq('message_id', interaction.message.id)
    .eq('status', 'in_progress')
    .single();

  if (!match) return;

  const { data: player } = await supabase
    .from('eights_match_players').select('id')
    .eq('match_id', match.id).eq('discord_id', discordId).single();

  if (!player) return interaction.followUp({ content: '❌ You weren\'t in this match.', ephemeral: true });

  await supabase.from('eights_match_players')
    .update({ voted_winner: winnerTeam })
    .eq('match_id', match.id).eq('discord_id', discordId);

  const { data: allVotes } = await supabase
    .from('eights_match_players').select('voted_winner, team, discord_id')
    .eq('match_id', match.id);

  const total    = (allVotes || []).length;
  const majority = Math.floor(total / 2) + 1;
  const t1Votes  = (allVotes || []).filter(v => v.voted_winner === 1).length;
  const t2Votes  = (allVotes || []).filter(v => v.voted_winner === 2).length;

  if (t1Votes >= majority || t2Votes >= majority) {
    const winner = t1Votes >= majority ? 1 : 2;

    await supabase.from('eights_matches').update({
      status:       'completed',
      winner_team:  winner,
      completed_at: new Date().toISOString(),
    }).eq('id', match.id);

    // Apply MMR
    const { data: config } = await supabase
      .from('eights_channel_config').select('mmr_enabled, results_channel_id')
      .eq('guild_id', match.guild_id).eq('channel_id', match.channel_id).single();
    const mmrEnabled = config?.mmr_enabled ?? true;

    let deltas: any[] = [];
    if (mmrEnabled) {
      deltas = await applyMmrAfterMatch(match.id, match.guild_id, winner as 1 | 2);
    }

    const team1Players = (allVotes || []).filter(v => v.team === 1).map(v => `<@${v.discord_id}>`);
    const team2Players = (allVotes || []).filter(v => v.team === 2).map(v => `<@${v.discord_id}>`);

    const bo5Maps: Bo5Map[] = Array.isArray(match.bo5_maps) ? match.bo5_maps : [];

    const winEmbed = buildWinnerEmbed(
      team1Players,
      team2Players,
      winner as 1 | 2,
      deltas,
      bo5Maps,
      match.match_number,
      mmrEnabled
    );

    // Post winner to results channel if configured, else the main queue channel
    const resultsChannelId = config?.results_channel_id ?? null;
    const targetChId = (resultsChannelId && resultsChannelId !== match.channel_id)
      ? resultsChannelId
      : match.channel_id;

    try {
      const targetCh = await interaction.client.channels.fetch(targetChId) as any;
      if (targetCh && 'send' in targetCh) {
        await targetCh.send({ embeds: [winEmbed] });
      }
    } catch (err) {
      console.error('[handleResultButton] Could not post winner embed:', err);
    }

    // Delete private match text channel (if it's different from the main queue channel)
    const textChId = match.text_channel_id;
    if (textChId && textChId !== match.channel_id) {
      try {
        const ch = await interaction.client.channels.fetch(textChId);
        if (ch) await (ch as any).delete('Match completed').catch(() => {});
      } catch {}
    }

    // Move players back to lobby VC, then delete team VCs
    const vcIds = (match.voice_channel_id || '').split(',').filter(Boolean);
    if (vcIds.length > 0 && interaction.guild) {
      const { data: vcCfg } = await supabase
        .from('eights_channel_config')
        .select('lobby_vc_id')
        .eq('guild_id', match.guild_id)
        .eq('channel_id', match.channel_id)
        .single();

      const lobbyVcId = vcCfg?.lobby_vc_id ?? null;
      const lobbyVc   = lobbyVcId
        ? interaction.guild.channels.cache.get(lobbyVcId) as VoiceChannel | undefined
        : undefined;

      for (const vcId of vcIds) {
        try {
          const vc = interaction.guild.channels.cache.get(vcId) as VoiceChannel | undefined;
          if (vc) {
            if (lobbyVc) {
              for (const [, member] of vc.members) {
                await member.voice.setChannel(lobbyVc).catch(() => {});
              }
            }
            await vc.delete('Match completed').catch(() => {});
          } else {
            // Not in cache — fetch and delete without moving (can't read members)
            const fetched = await interaction.client.channels.fetch(vcId).catch(() => null);
            if (fetched) await (fetched as any).delete('Match completed').catch(() => {});
          }
        } catch {}
      }
    }

  } else {
    await interaction.followUp({
      content: `✅ Vote recorded. [T1: ${t1Votes} | T2: ${t2Votes}] — need ${majority} to confirm.`,
      ephemeral: true,
    });
  }
}
