import { Client, Guild, TextChannel } from 'discord.js';
import { supabase } from './supabase';
import { startFirstJoinTimerForQueue, refreshQueueEmbed } from './queueFlow';
import { recoverVcPhase } from './vcFlow';

const FIRST_JOIN_MINUTES = 15; // must match queueFlow.ts constant

export async function recoverOnStartup(client: Client) {
  console.log('[startup] Running state recovery...');
  try {
    await Promise.all([
      recoverFirstJoinTimers(client),
      recoverVcPhases(client),
      cancelStuckQueues(client),
    ]);
  } catch (err) {
    console.error('[startup] Recovery error:', err);
  }
  console.log('[startup] State recovery complete.');
}

// ─── First-join timers ────────────────────────────────────────────────────────

async function recoverFirstJoinTimers(client: Client) {
  const { data: queues } = await supabase
    .from('eights_queues')
    .select('id, guild_id, channel_id, game_id, team_size, first_join_at, message_id')
    .eq('status', 'waiting')
    .not('first_join_at', 'is', null);

  if (!queues?.length) return;

  for (const queue of queues) {
    const elapsed     = Date.now() - new Date(queue.first_join_at).getTime();
    const remainingMs = FIRST_JOIN_MINUTES * 60 * 1000 - elapsed;

    const { data: config } = await supabase
      .from('eights_channel_config')
      .select('mmr_enabled, inactivity_minutes, queue_name, game_id')
      .eq('guild_id', queue.guild_id)
      .eq('channel_id', queue.channel_id)
      .single();

    const gameId = config?.game_id || queue.game_id;
    const { data: gameRow } = gameId
      ? await supabase.from('games').select('name').eq('id', gameId).single()
      : { data: null };
    const displayName = config?.queue_name || gameRow?.name || 'Queue';

    startFirstJoinTimerForQueue({
      queueId:           queue.id,
      channelId:         queue.channel_id,
      guildId:           queue.guild_id,
      gameId:            queue.game_id,
      teamSize:          queue.team_size,
      displayName,
      mmrEnabled:        config?.mmr_enabled ?? true,
      inactivityMinutes: config?.inactivity_minutes ?? 60,
      client,
      currentMsgId:      queue.message_id,
      delayMs:           remainingMs, // 0 or negative fires immediately
    });

    console.log(`[startup] Recovered first-join timer for queue ${queue.id} (${Math.round(remainingMs / 1000)}s remaining)`);
  }
}

// ─── VC phase recovery ────────────────────────────────────────────────────────

async function recoverVcPhases(client: Client) {
  const { data: matches } = await supabase
    .from('eights_matches')
    .select('id, queue_id, guild_id, channel_id, game_id, voice_channel_id, vc_phase_started_at, text_channel_id')
    .eq('status', 'in_progress')
    .not('vc_phase_started_at', 'is', null)
    .not('voice_channel_id', 'is', null);

  if (!matches?.length) return;

  for (const match of matches) {
    const { data: config } = await supabase
      .from('eights_channel_config')
      .select('vc_join_minutes, lobby_vc_id, mmr_enabled, inactivity_minutes, queue_name, staff_role_id')
      .eq('guild_id', match.guild_id)
      .eq('channel_id', match.channel_id)
      .single();

    const vcJoinMinutes = config?.vc_join_minutes ?? 5;
    const elapsed       = Date.now() - new Date(match.vc_phase_started_at).getTime();
    const remainingMs   = vcJoinMinutes * 60 * 1000 - elapsed;

    const guild = client.guilds.cache.get(match.guild_id) as Guild | undefined;
    if (!guild) continue;

    const { data: players } = await supabase
      .from('eights_match_players')
      .select('discord_id, team')
      .eq('match_id', match.id);

    if (!players?.length) continue;

    const team1Ids = players.filter((p: any) => p.team === 1).map((p: any) => p.discord_id as string);
    const team2Ids = players.filter((p: any) => p.team === 2).map((p: any) => p.discord_id as string);

    const vcIds = (match.voice_channel_id as string || '').split(',').filter(Boolean);
    if (vcIds.length < 2) continue;

    const { data: gameRow } = match.game_id
      ? await supabase.from('games').select('name').eq('id', match.game_id).single()
      : { data: null };

    const gameName       = config?.queue_name || gameRow?.name || 'Queue';
    const mmrEnabled     = config?.mmr_enabled ?? true;
    const inactivityMins = config?.inactivity_minutes ?? 60;
    const teamSize       = team1Ids.length;
    const vcChannelId    = match.channel_id as string;
    const vcGuildId      = match.guild_id as string;
    const vcGameId       = match.game_id as string;

    const onRequeue = async (newQueueId: string, presentIds: string[], ch: TextChannel) => {
      const msgId = await refreshQueueEmbed(ch, newQueueId, teamSize, gameName, mmrEnabled, null, inactivityMins);
      if (msgId) await supabase.from('eights_queues').update({ message_id: msgId }).eq('id', newQueueId);
      if (presentIds.length > 0) {
        startFirstJoinTimerForQueue({
          queueId: newQueueId, channelId: vcChannelId, guildId: vcGuildId,
          gameId: vcGameId, teamSize, displayName: gameName, mmrEnabled,
          inactivityMinutes: inactivityMins, client, currentMsgId: msgId,
        });
      }
    };

    recoverVcPhase(
      match.id,
      {
        matchId:               match.id,
        queueId:               match.queue_id,
        queueChannelId:        match.channel_id,
        announcementChannelId: match.text_channel_id || match.channel_id,
        guildId:               match.guild_id,
        guild,
        teamSize,
        gameName,
        mmrEnabled,
        gameId:      match.game_id,
        team1Ids,
        team2Ids,
        team1VcId:   vcIds[0],
        team2VcId:   vcIds[1],
        lobbyVcId:   config?.lobby_vc_id ?? null,
        staffRoleId: config?.staff_role_id ?? null,
        vcJoinMinutes,
        onRequeue,
      },
      remainingMs
    );

    console.log(`[startup] Recovered VC phase for match ${match.id} (${Math.round(remainingMs / 1000)}s remaining)`);
  }
}

// ─── Cancel stuck queues (voting_teams and orphaned captain drafts) ───────────

async function cancelStuckQueues(client: Client) {
  // voting_teams queues: the 30-second vote window is long past
  const { data: votingQueues } = await supabase
    .from('eights_queues')
    .select('id, guild_id, channel_id, game_id, team_size')
    .eq('status', 'voting_teams');

  // in_progress queues with no active match = stuck captain draft
  const { data: inProgressQueues } = await supabase
    .from('eights_queues')
    .select('id, guild_id, channel_id, game_id, team_size')
    .eq('status', 'in_progress');

  const stuckDrafts: typeof inProgressQueues = [];
  for (const queue of inProgressQueues || []) {
    const { data: match } = await supabase
      .from('eights_matches')
      .select('id')
      .eq('queue_id', queue.id)
      .eq('status', 'in_progress')
      .maybeSingle();
    if (!match) stuckDrafts.push(queue);
  }

  const allStuck = [...(votingQueues || []), ...stuckDrafts];
  if (!allStuck.length) return;

  for (const queue of allStuck) {
    await supabase.from('eights_queues').update({ status: 'cancelled' }).eq('id', queue.id);
    await supabase.from('eights_queue_players').delete().eq('queue_id', queue.id);

    // Create a fresh waiting queue and post embed so the channel is usable
    const { data: config } = await supabase
      .from('eights_channel_config')
      .select('mmr_enabled, inactivity_minutes, queue_name, game_id')
      .eq('guild_id', queue.guild_id)
      .eq('channel_id', queue.channel_id)
      .single();

    const { data: gameRow } = (config?.game_id || queue.game_id)
      ? await supabase.from('games').select('name').eq('id', config?.game_id || queue.game_id).single()
      : { data: null };
    const displayName = config?.queue_name || gameRow?.name || 'Queue';

    const { data: freshQueue } = await supabase
      .from('eights_queues')
      .insert({
        guild_id:   queue.guild_id,
        channel_id: queue.channel_id,
        game_id:    queue.game_id,
        team_size:  queue.team_size,
        status:     'waiting',
      })
      .select('id')
      .single();

    if (freshQueue) {
      try {
        const ch = await client.channels.fetch(queue.channel_id) as TextChannel;
        const msgId = await refreshQueueEmbed(
          ch, freshQueue.id, queue.team_size, displayName,
          config?.mmr_enabled ?? true, null, config?.inactivity_minutes ?? 60
        );
        if (msgId) await supabase.from('eights_queues').update({ message_id: msgId }).eq('id', freshQueue.id);
      } catch (err) {
        console.error(`[startup] Failed to post recovery embed for queue ${queue.id}:`, err);
      }
    }

    console.log(`[startup] Cancelled stuck queue ${queue.id} and created fresh queue`);
  }
}
