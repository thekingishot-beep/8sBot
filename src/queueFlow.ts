import { ButtonInteraction, Message, TextChannel } from 'discord.js';
import { supabase } from './supabase';
import { getMapPool, pickRandomMaps } from './mapPool';
import {
  buildQueueEmbed,
  buildTeamVoteEmbed,
  buildMapVoteEmbed,
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

const TEAM_VOTE_SECONDS = 30;
const MAP_VOTE_SECONDS  = 60;

// ─── Shared helper: refresh the queue embed in the channel ───────────────────

export async function refreshQueueEmbed(
  channel: any,
  queueId: string,
  teamSize: number,
  gameName: string,
  mmrEnabled: boolean,
  existingMessageId?: string | null
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

  if (existingMessageId) {
    try {
      const msg = await channel.messages.fetch(existingMessageId);
      await msg.edit({ embeds: [embed], components: [row] });
      return existingMessageId;
    } catch { /* message deleted — fall through to send */ }
  }

  const msg = await channel.send({ embeds: [embed], components: [row] });
  return msg.id;
}

// ─── Queue full — trigger team vote ──────────────────────────────────────────

export async function handleQueueFull(
  channel: any,
  queueId: string,
  teamSize: number,
  gameName: string,
  mmrEnabled: boolean,
  existingMessageId: string | null
) {
  await supabase.from('eights_queues').update({ status: 'voting_teams' }).eq('id', queueId);

  const { embed, rows } = buildTeamVoteEmbed({}, {});

  let voteMsg: Message;
  if (existingMessageId) {
    try {
      const old = await channel.messages.fetch(existingMessageId);
      voteMsg = await old.edit({
        content: `@here Queue is full! Vote for team selection — **${TEAM_VOTE_SECONDS}s**`,
        embeds: [embed],
        components: rows,
      });
    } catch {
      voteMsg = await channel.send({
        content: `@here Queue is full! Vote for team selection — **${TEAM_VOTE_SECONDS}s**`,
        embeds: [embed],
        components: rows,
      });
    }
  } else {
    voteMsg = await channel.send({
      content: `@here Queue is full! Vote for team selection — **${TEAM_VOTE_SECONDS}s**`,
      embeds: [embed],
      components: rows,
    });
  }

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

  const channel = interaction.channel as TextChannel;
  const newMsgId = await refreshQueueEmbed(channel, queue.id, config.team_size, gameName?.name || 'Queue', config.mmr_enabled, queue.message_id);
  if (newMsgId && newMsgId !== queue.message_id) {
    await supabase.from('eights_queues').update({ message_id: newMsgId }).eq('id', queue.id);
  }

  await interaction.editReply({ content: `✅ You joined the queue! [${count}/${total}]` });

  if (count >= total) {
    const ch = interaction.channel as TextChannel;
    await handleQueueFull(ch, queue.id, config.team_size, gameName?.name || 'Queue', config.mmr_enabled, newMsgId || queue.message_id);
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
  const { data: config }   = await supabase.from('eights_channel_config').select('mmr_enabled')
    .eq('guild_id', interaction.guildId!).eq('channel_id', interaction.channelId).single();

  const ch = interaction.channel as TextChannel;
  await refreshQueueEmbed(ch, queue.id, queue.team_size, gameName?.name || 'Queue', config?.mmr_enabled ?? true, queue.message_id);

  await interaction.editReply({ content: '✅ You left the queue.' });
}

// ─── Force start (admin only) ─────────────────────────────────────────────────

export async function handleForceStart(interaction: ButtonInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member = interaction.member as any;
  const hasPerms = member?.permissions?.has?.('ManageChannels');
  if (!hasPerms) return interaction.editReply({ content: '❌ Only staff can force start.' });

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

  const member = interaction.member as any;
  const hasPerms = member?.permissions?.has?.('ManageChannels');
  if (!hasPerms) return interaction.editReply({ content: '❌ Only staff can cancel the queue.' });

  const { data: queue } = await supabase
    .from('eights_queues').select('*')
    .eq('guild_id', interaction.guildId!)
    .eq('channel_id', interaction.channelId)
    .eq('status', 'waiting')
    .single();

  if (!queue) return interaction.editReply({ content: '❌ No waiting queue to cancel.' });

  await supabase.from('eights_queues').update({ status: 'cancelled' }).eq('id', queue.id);

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
  choice: 'random' | 'captains' | 'balanced' | 'unfair'
) {
  await interaction.deferUpdate();
  const discordId = interaction.user.id;

  const { data: queue } = await supabase
    .from('eights_queues').select('*')
    .eq('channel_id', interaction.channelId)
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
  const { embed, rows } = buildTeamVoteEmbed(votes, mmrVotes);
  await interaction.message.edit({ embeds: [embed], components: rows });

  await interaction.followUp({ content: `✅ Voted **${choice}**.`, ephemeral: true });
}

// ─── MMR vote buttons ─────────────────────────────────────────────────────────

export async function handleMmrVoteButton(interaction: ButtonInteraction, choice: 'enable' | 'disable') {
  await interaction.deferUpdate();
  const discordId = interaction.user.id;

  const { data: queue } = await supabase
    .from('eights_queues').select('*')
    .eq('channel_id', interaction.channelId)
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
  const { embed, rows } = buildTeamVoteEmbed(teamVotes, mmrVotes);
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

  // Resolve team selection winner
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
    if (counts.balanced === max)  winner = 'balanced';
    else if (counts.captains === max) winner = 'captains';
    else if (counts.unfair === max)   winner = 'unfair';
  }

  // Resolve MMR toggle vote
  const mmrVotes: Record<string, string[]> = queue.mmr_vote || {};
  const mmrEnabled = (mmrVotes['disable'] || []).length > (mmrVotes['enable'] || []).length
    ? false
    : mmrEnabledDefault;

  await supabase.from('eights_queues').update({
    status: 'voting_map',
    chosen_team_selection: winner,
  }).eq('id', queueId);

  const { data: players } = await supabase
    .from('eights_queue_players').select('discord_id, profile_id, mmr_at_queue_time')
    .eq('queue_id', queueId);

  if (!players) return;

  const mmrMap = Object.fromEntries(players.map(p => [p.discord_id, p.mmr_at_queue_time ?? MMR_START]));
  const playerObjs = players.map(p => ({ discord_id: p.discord_id, profile_id: p.profile_id }));

  if (winner === 'captains') {
    const channel = voteMsg.channel;
    await startCaptainDraft(queue, playerObjs, mmrEnabled, channel, voteMsg);
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
    team1 = shuffled.slice(0, teamSize);
    team2 = shuffled.slice(teamSize);
  }

  const pool = await getMapPool(queue.game_id);
  const mapOptions = pickRandomMaps(pool, 4);

  if (mapOptions.length === 0) {
    await startMatchFromTeams(queueId, team1, team2, 'TBD', 'TBD', winner, voteMsg);
    return;
  }

  await supabase.from('eights_queues').update({
    map_options: mapOptions,
    status: 'voting_map',
    captain_teams: { team1, team2 },
  }).eq('id', queueId);

  const { embed: mapEmbed, row: mapRow } = buildMapVoteEmbed(mapOptions);
  await voteMsg.edit({
    content: `🗺️ Team selection: **${winner}**! Now vote for the map — **${MAP_VOTE_SECONDS}s**`,
    embeds: [mapEmbed],
    components: [mapRow],
  });

  setTimeout(() => resolveCaptainMapVote(queueId, team1, team2, mapOptions, voteMsg), MAP_VOTE_SECONDS * 1000);
}

// ─── Map vote button ──────────────────────────────────────────────────────────

export async function handleMapVoteButton(interaction: ButtonInteraction, mapId: string) {
  await interaction.deferUpdate();
  const discordId = interaction.user.id;

  const { data: queue } = await supabase
    .from('eights_queues').select('*')
    .eq('channel_id', interaction.channelId)
    .eq('status', 'voting_map')
    .single();

  if (!queue) return;

  const { data: player } = await supabase
    .from('eights_queue_players').select('id')
    .eq('queue_id', queue.id).eq('discord_id', discordId).single();

  if (!player) return interaction.followUp({ content: '❌ You\'re not in this queue.', ephemeral: true });

  const mapVotes: Record<string, string[]> = queue.map_vote || {};
  for (const key of Object.keys(mapVotes)) mapVotes[key] = mapVotes[key].filter((id: string) => id !== discordId);
  if (!mapVotes[mapId]) mapVotes[mapId] = [];
  mapVotes[mapId].push(discordId);

  await supabase.from('eights_queues').update({ map_vote: mapVotes }).eq('id', queue.id);
  await interaction.followUp({ content: '✅ Map vote recorded.', ephemeral: true });
}

// ─── Resolve map vote (shared between random/balanced/unfair + captain paths) ─

export async function resolveCaptainMapVote(
  queueId: string,
  team1: any[],
  team2: any[],
  mapOptions: Array<{ id: string; name: string; mode: string; modeName: string }>,
  voteMsg: Message
) {
  const { data: fresh } = await supabase.from('eights_queues').select('*').eq('id', queueId).single();
  if (!fresh || fresh.status !== 'voting_map') return;

  const votes: Record<string, string[]> = fresh.map_vote || {};
  let chosenMapId = mapOptions[0]?.id;
  let maxVotes = -1;
  for (const [mapId, voters] of Object.entries(votes)) {
    if ((voters as string[]).length > maxVotes) {
      maxVotes = (voters as string[]).length;
      chosenMapId = mapId;
    }
  }

  const chosenMap = mapOptions.find(m => m.id === chosenMapId);
  await startMatchFromTeams(queueId, team1, team2, chosenMap?.name || 'TBD', chosenMap?.modeName || 'TBD', fresh.chosen_team_selection || 'random', voteMsg);
}

// ─── Start match (shared entry point) ────────────────────────────────────────

export async function startMatchFromTeams(
  queueId: string,
  team1: Array<{ discord_id: string; profile_id: string | null }>,
  team2: Array<{ discord_id: string; profile_id: string | null }>,
  map: string,
  mode: string,
  teamSelection: string,
  voteMsg: Message
) {
  const { data: queue } = await supabase.from('eights_queues').select('*').eq('id', queueId).single();
  if (!queue) return;

  await supabase.from('eights_queues').update({
    status: 'in_progress',
    chosen_map: map,
    chosen_mode: mode,
  }).eq('id', queueId);

  // Get next match number for this guild
  const { count } = await supabase
    .from('eights_matches')
    .select('id', { count: 'exact', head: true })
    .eq('guild_id', queue.guild_id);
  const matchNumber = (count || 0) + 1;

  const { data: match } = await supabase.from('eights_matches').insert({
    queue_id:       queueId,
    guild_id:       queue.guild_id,
    channel_id:     queue.channel_id,
    game_id:        queue.game_id,
    map,
    mode,
    team_selection: teamSelection,
    status:         'in_progress',
    match_number:   matchNumber,
  }).select().single();

  if (!match) return;

  const playerRows = [
    ...team1.map(p => ({ match_id: match.id, discord_id: p.discord_id, profile_id: p.profile_id, team: 1 })),
    ...team2.map(p => ({ match_id: match.id, discord_id: p.discord_id, profile_id: p.profile_id, team: 2 })),
  ];
  await supabase.from('eights_match_players').insert(playerRows);

  const team1Tags = team1.map(p => `<@${p.discord_id}>`);
  const team2Tags = team2.map(p => `<@${p.discord_id}>`);

  const { embed, row } = buildMatchEmbed(team1Tags, team2Tags, map, mode, teamSelection, matchNumber);
  await voteMsg.edit({ content: '⚔️ Match is live!', embeds: [embed], components: [row] });
  await supabase.from('eights_matches').update({ message_id: voteMsg.id }).eq('id', match.id);
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

  const total     = (allVotes || []).length;
  const majority  = Math.floor(total / 2) + 1;
  const t1Votes   = (allVotes || []).filter(v => v.voted_winner === 1).length;
  const t2Votes   = (allVotes || []).filter(v => v.voted_winner === 2).length;

  if (t1Votes >= majority || t2Votes >= majority) {
    const winner = t1Votes >= majority ? 1 : 2;

    await supabase.from('eights_matches').update({
      status:       'completed',
      winner_team:  winner,
      completed_at: new Date().toISOString(),
    }).eq('id', match.id);

    // Disable result buttons
    try {
      await interaction.message.edit({ components: [] });
    } catch { /* ignore */ }

    // Apply MMR
    const { data: config } = await supabase
      .from('eights_channel_config').select('mmr_enabled')
      .eq('guild_id', match.guild_id).eq('channel_id', match.channel_id).single();
    const mmrEnabled = config?.mmr_enabled ?? true;

    let deltas: any[] = [];
    if (mmrEnabled) {
      deltas = await applyMmrAfterMatch(match.id, match.guild_id, winner as 1 | 2);
    }

    // Fetch team tags for winner card
    const team1Players = (allVotes || []).filter(v => v.team === 1).map(v => `<@${v.discord_id}>`);
    const team2Players = (allVotes || []).filter(v => v.team === 2).map(v => `<@${v.discord_id}>`);

    const winEmbed = buildWinnerEmbed(
      team1Players,
      team2Players,
      winner as 1 | 2,
      deltas,
      match.map || 'TBD',
      match.mode || 'TBD',
      match.match_number,
      mmrEnabled
    );

    await interaction.followUp({ embeds: [winEmbed] });
  } else {
    await interaction.followUp({
      content: `✅ Vote recorded. [T1: ${t1Votes} | T2: ${t2Votes}] — need ${majority} to confirm.`,
      ephemeral: true,
    });
  }
}
