import { ChatInputCommandInteraction, ButtonInteraction, Message } from 'discord.js';
import { supabase } from './supabase';
import { getMapPool, pickRandomMaps } from './mapPool';
import { buildTeamVoteEmbed, buildMapVoteEmbed, buildMatchEmbed } from './queueEmbed';

const TEAM_VOTE_SECONDS = 30;
const MAP_VOTE_SECONDS  = 60;

// Called when the queue fills — posts the team selection vote
export async function handleQueueFull(
  interaction: ChatInputCommandInteraction,
  queueId: string,
  teamSize: number
) {
  await supabase.from('eights_queues').update({ status: 'voting_teams' }).eq('id', queueId);

  const { embed, row } = buildTeamVoteEmbed();
  const channel = interaction.channel;
  if (!channel || !('send' in channel)) return;

  const voteMsg = await (channel as any).send({
    content: `@here Queue is full! Vote for team selection — **${TEAM_VOTE_SECONDS}s**`,
    embeds: [embed],
    components: [row],
  });

  // Auto-resolve after timeout
  setTimeout(async () => {
    await resolveTeamVote(queueId, teamSize, voteMsg, interaction);
  }, TEAM_VOTE_SECONDS * 1000);
}

// Handle a team vote button click
export async function handleTeamVoteButton(interaction: ButtonInteraction, choice: 'random' | 'captains' | 'balanced') {
  await interaction.deferUpdate();
  const discordId = interaction.user.id;

  const { data: queue } = await supabase
    .from('eights_queues')
    .select('*')
    .eq('channel_id', interaction.channelId)
    .eq('status', 'voting_teams')
    .single();

  if (!queue) return;

  // Verify voter is in the queue
  const { data: player } = await supabase
    .from('eights_queue_players')
    .select('id')
    .eq('queue_id', queue.id)
    .eq('discord_id', discordId)
    .single();

  if (!player) {
    return interaction.followUp({ content: '❌ You\'re not in this queue.', ephemeral: true });
  }

  // Record vote (each player gets one vote — overwrite their previous)
  const currentVotes: Record<string, string[]> = queue.team_vote || {};
  for (const key of Object.keys(currentVotes)) {
    currentVotes[key] = (currentVotes[key] as string[]).filter((id: string) => id !== discordId);
  }
  if (!currentVotes[choice]) currentVotes[choice] = [];
  currentVotes[choice].push(discordId);

  await supabase.from('eights_queues').update({ team_vote: currentVotes }).eq('id', queue.id);

  await interaction.followUp({
    content: `✅ You voted for **${choice}** teams.`,
    ephemeral: true,
  });
}

async function resolveTeamVote(
  queueId: string,
  teamSize: number,
  voteMsg: Message,
  interaction: ChatInputCommandInteraction
) {
  const { data: queue } = await supabase
    .from('eights_queues')
    .select('*')
    .eq('id', queueId)
    .single();

  if (!queue || queue.status !== 'voting_teams') return;

  const votes: Record<string, string[]> = queue.team_vote || {};
  const counts = {
    random:   (votes['random']   || []).length,
    captains: (votes['captains'] || []).length,
    balanced: (votes['balanced'] || []).length,
  };

  // Majority or fallback to random
  let winner: 'random' | 'captains' | 'balanced' = 'random';
  if (counts.captains > counts.random && counts.captains > counts.balanced) winner = 'captains';
  else if (counts.balanced > counts.random && counts.balanced > counts.captains) winner = 'balanced';

  await supabase.from('eights_queues').update({
    status: 'voting_map',
    chosen_team_selection: winner,
  }).eq('id', queueId);

  // Fetch players and assign teams
  const { data: players } = await supabase
    .from('eights_queue_players')
    .select('discord_id, profile_id')
    .eq('queue_id', queueId);

  const shuffled = [...(players || [])].sort(() => Math.random() - 0.5);

  // For now: random/balanced both use random split — captain pick is a separate flow
  // TODO: balanced split by win rate, captain pick interactive flow
  const team1 = shuffled.slice(0, teamSize);
  const team2 = shuffled.slice(teamSize);

  // Start map vote
  const pool = await getMapPool(queue.game_id);
  const mapOptions = pickRandomMaps(pool, 4);

  if (mapOptions.length === 0) {
    // No maps configured — skip map vote and go straight to match
    await startMatch(queueId, queue, team1, team2, 'TBD', 'TBD', winner, voteMsg);
    return;
  }

  await supabase.from('eights_queues').update({
    map_options: mapOptions,
    status: 'voting_map',
  }).eq('id', queueId);

  const { embed: mapEmbed, row: mapRow } = buildMapVoteEmbed(mapOptions);
  await voteMsg.edit({
    content: `🗺️ Team selection: **${winner}**! Now vote for the map — **${MAP_VOTE_SECONDS}s**`,
    embeds: [mapEmbed],
    components: [mapRow],
  });

  setTimeout(async () => {
    await resolveMapVote(queueId, queue, team1, team2, mapOptions, winner, voteMsg);
  }, MAP_VOTE_SECONDS * 1000);
}

export async function handleMapVoteButton(interaction: ButtonInteraction, mapId: string) {
  await interaction.deferUpdate();
  const discordId = interaction.user.id;

  const { data: queue } = await supabase
    .from('eights_queues')
    .select('*')
    .eq('channel_id', interaction.channelId)
    .eq('status', 'voting_map')
    .single();

  if (!queue) return;

  const { data: player } = await supabase
    .from('eights_queue_players')
    .select('id')
    .eq('queue_id', queue.id)
    .eq('discord_id', discordId)
    .single();

  if (!player) {
    return interaction.followUp({ content: '❌ You\'re not in this queue.', ephemeral: true });
  }

  const currentVotes: Record<string, string[]> = queue.map_vote || {};
  for (const key of Object.keys(currentVotes)) {
    currentVotes[key] = currentVotes[key].filter((id: string) => id !== discordId);
  }
  if (!currentVotes[mapId]) currentVotes[mapId] = [];
  currentVotes[mapId].push(discordId);

  await supabase.from('eights_queues').update({ map_vote: currentVotes }).eq('id', queue.id);
  await interaction.followUp({ content: `✅ Map vote recorded.`, ephemeral: true });
}

async function resolveMapVote(
  queueId: string,
  queue: any,
  team1: any[],
  team2: any[],
  mapOptions: Array<{ id: string; name: string; mode: string; modeName: string }>,
  teamSelection: string,
  voteMsg: Message
) {
  const { data: fresh } = await supabase.from('eights_queues').select('*').eq('id', queueId).single();
  if (!fresh || fresh.status !== 'voting_map') return;

  const votes: Record<string, string[]> = fresh.map_vote || {};
  let chosenMapId = mapOptions[0]?.id;
  let maxVotes = 0;
  for (const [mapId, voters] of Object.entries(votes)) {
    if ((voters as string[]).length > maxVotes) {
      maxVotes = (voters as string[]).length;
      chosenMapId = mapId;
    }
  }

  const chosenMap = mapOptions.find(m => m.id === chosenMapId);
  await startMatch(queueId, queue, team1, team2, chosenMap?.name || 'TBD', chosenMap?.modeName || 'TBD', teamSelection, voteMsg);
}

async function startMatch(
  queueId: string,
  queue: any,
  team1: any[],
  team2: any[],
  map: string,
  mode: string,
  teamSelection: string,
  voteMsg: Message
) {
  await supabase.from('eights_queues').update({ status: 'in_progress', chosen_map: map, chosen_mode: mode }).eq('id', queueId);

  // Create match record
  const { data: match } = await supabase.from('eights_matches').insert({
    queue_id:       queueId,
    guild_id:       queue.guild_id,
    channel_id:     queue.channel_id,
    game_id:        queue.game_id,
    map,
    mode,
    team_selection: teamSelection,
    status:         'in_progress',
  }).select().single();

  if (!match) return;

  // Insert all players with team assignments
  const playerRows = [
    ...team1.map(p => ({ match_id: match.id, discord_id: p.discord_id, profile_id: p.profile_id, team: 1 })),
    ...team2.map(p => ({ match_id: match.id, discord_id: p.discord_id, profile_id: p.profile_id, team: 2 })),
  ];
  await supabase.from('eights_match_players').insert(playerRows);

  const team1Tags = team1.map(p => `<@${p.discord_id}>`);
  const team2Tags = team2.map(p => `<@${p.discord_id}>`);

  const { embed, row } = buildMatchEmbed(team1Tags, team2Tags, map, mode, teamSelection);
  await voteMsg.edit({ content: '⚔️ Match is live!', embeds: [embed], components: [row] });

  // Store match message id
  await supabase.from('eights_matches').update({ message_id: voteMsg.id }).eq('id', match.id);
}

// Handle result vote button (result_1 or result_2)
export async function handleResultButton(interaction: ButtonInteraction, winnerTeam: 1 | 2) {
  await interaction.deferUpdate();
  const discordId = interaction.user.id;

  // Find the match via message id
  const { data: match } = await supabase
    .from('eights_matches')
    .select('*')
    .eq('message_id', interaction.message.id)
    .eq('status', 'in_progress')
    .single();

  if (!match) return;

  // Verify voter is in the match
  const { data: player } = await supabase
    .from('eights_match_players')
    .select('id')
    .eq('match_id', match.id)
    .eq('discord_id', discordId)
    .single();

  if (!player) {
    return interaction.followUp({ content: '❌ You weren\'t in this match.', ephemeral: true });
  }

  await supabase.from('eights_match_players')
    .update({ voted_winner: winnerTeam })
    .eq('match_id', match.id)
    .eq('discord_id', discordId);

  // Check if majority reached (5 of 8)
  const { data: allVotes } = await supabase
    .from('eights_match_players')
    .select('voted_winner')
    .eq('match_id', match.id);

  const total = (allVotes || []).length;
  const majority = Math.floor(total / 2) + 1;

  const team1Votes = (allVotes || []).filter(v => v.voted_winner === 1).length;
  const team2Votes = (allVotes || []).filter(v => v.voted_winner === 2).length;

  if (team1Votes >= majority || team2Votes >= majority) {
    const winner = team1Votes >= majority ? 1 : 2;
    await supabase.from('eights_matches').update({
      status: 'completed',
      winner_team: winner,
      completed_at: new Date().toISOString(),
    }).eq('id', match.id);

    await interaction.followUp({
      content: `🏆 **Team ${winner}** wins! Result confirmed by majority vote. GG!`,
    });
  } else {
    await interaction.followUp({
      content: `✅ Vote recorded. [T1: ${team1Votes} | T2: ${team2Votes}] — need ${majority} to confirm.`,
      ephemeral: true,
    });
  }
}
