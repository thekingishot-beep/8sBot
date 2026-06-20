import {
  Guild,
  VoiceChannel,
  TextChannel,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { supabase } from './supabase';

interface VcPhaseState {
  matchId:        string;
  queueId:        string;
  queueChannelId: string;
  guildId:        string;
  guild:          Guild;
  teamSize:       number;
  gameName:       string;
  mmrEnabled:     boolean;
  gameId:         string;
  team1Ids:       string[];
  team2Ids:       string[];
  team1VcId:      string;
  team2VcId:      string;
  lobbyVcId:      string | null;
  vcJoinMinutes:  number;
  onRequeue:      (newQueueId: string, channel: TextChannel) => Promise<void>;
  timer:          ReturnType<typeof setTimeout>;
}

const vcPhases = new Map<string, VcPhaseState>();

// ─── Start VC phase after match embed is posted ───────────────────────────────

export async function startVcPhase(params: {
  guild:          Guild;
  matchId:        string;
  queueId:        string;
  queueChannelId: string;
  guildId:        string;
  teamSize:       number;
  gameName:       string;
  mmrEnabled:     boolean;
  gameId:         string;
  team1Ids:       string[];
  team2Ids:       string[];
  lobbyVcId:      string | null;
  vcJoinMinutes:  number;
  onRequeue:      (newQueueId: string, channel: TextChannel) => Promise<void>;
}) {
  const {
    guild, matchId, queueId, queueChannelId, guildId,
    teamSize, gameName, mmrEnabled, gameId,
    team1Ids, team2Ids, lobbyVcId, vcJoinMinutes, onRequeue,
  } = params;

  // Use the same category as the lobby VC (if set), so team VCs sit alongside it
  let categoryId: string | undefined;
  if (lobbyVcId) {
    const lobbyChannel = guild.channels.cache.get(lobbyVcId);
    if (lobbyChannel?.parentId) categoryId = lobbyChannel.parentId;
  }

  let team1Vc: VoiceChannel, team2Vc: VoiceChannel;
  try {
    [team1Vc, team2Vc] = await Promise.all([
      guild.channels.create({
        name:      '🔵 Team 1',
        type:      ChannelType.GuildVoice,
        parent:    categoryId,
        userLimit: team1Ids.length,
      }) as Promise<VoiceChannel>,
      guild.channels.create({
        name:      '🔴 Team 2',
        type:      ChannelType.GuildVoice,
        parent:    categoryId,
        userLimit: team2Ids.length,
      }) as Promise<VoiceChannel>,
    ]);
  } catch (err) {
    console.error('[vcFlow] Failed to create team VCs — bot may be missing Manage Channels permission:', err);
    return;
  }

  // Move or DM every player
  await Promise.all([
    moveOrDmTeam(guild, team1Ids, team1Vc, vcJoinMinutes),
    moveOrDmTeam(guild, team2Ids, team2Vc, vcJoinMinutes),
  ]);

  // Announce in queue text channel
  try {
    const ch = await guild.channels.fetch(queueChannelId) as TextChannel | null;
    if (ch?.isTextBased()) {
      await ch.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('🎮 Match Started — Team VCs Created')
            .setColor(0x3B82F6)
            .setDescription(
              `Players in a voice channel have been moved automatically.\n` +
              `Players **not** in a VC have been DM'd with a link.\n\n` +
              `⏱️ You have **${vcJoinMinutes} minute${vcJoinMinutes !== 1 ? 's' : ''}** to join your team VC.  ` +
              `Anyone who misses the deadline cancels the match for everyone.`
            )
            .addFields(
              { name: '🔵 Team 1 VC', value: `<#${team1Vc.id}>`, inline: true },
              { name: '🔴 Team 2 VC', value: `<#${team2Vc.id}>`, inline: true },
            ),
        ],
      });
    }
  } catch {}

  const timer = setTimeout(() => checkVcPhase(matchId), vcJoinMinutes * 60 * 1000);

  vcPhases.set(matchId, {
    matchId, queueId, queueChannelId, guildId, guild,
    teamSize, gameName, mmrEnabled, gameId,
    team1Ids, team2Ids,
    team1VcId: team1Vc.id,
    team2VcId: team2Vc.id,
    lobbyVcId, vcJoinMinutes, onRequeue, timer,
  });
}

async function moveOrDmTeam(
  guild:        Guild,
  playerIds:    string[],
  targetVc:     VoiceChannel,
  joinMinutes:  number
) {
  for (const discordId of playerIds) {
    try {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (!member) continue;

      if (member.voice.channelId) {
        await member.voice.setChannel(targetVc).catch(() => {});
      } else {
        await member.send(
          `🎮 Your 8s match just started!\n\n` +
          `Please join your team voice channel: **${targetVc.name}** → <#${targetVc.id}>\n\n` +
          `You have **${joinMinutes} minute${joinMinutes !== 1 ? 's' : ''}** to join. ` +
          `If you don't make it, the match will be cancelled for everyone.`
        ).catch(() => {});
      }
    } catch {}
  }
}

// ─── Timer fires: check who made it ──────────────────────────────────────────

async function checkVcPhase(matchId: string) {
  const state = vcPhases.get(matchId);
  if (!state) return;
  vcPhases.delete(matchId);

  const { guild } = state;

  const team1Vc = guild.channels.cache.get(state.team1VcId) as VoiceChannel | undefined;
  const team2Vc = guild.channels.cache.get(state.team2VcId) as VoiceChannel | undefined;

  const inTeam1 = new Set(team1Vc?.members.map(m => m.id) ?? []);
  const inTeam2 = new Set(team2Vc?.members.map(m => m.id) ?? []);

  const missing1 = state.team1Ids.filter(id => !inTeam1.has(id));
  const missing2 = state.team2Ids.filter(id => !inTeam2.has(id));

  if (missing1.length === 0 && missing2.length === 0) {
    // All players present — match continues normally
    return;
  }

  const missingMentions = [...missing1, ...missing2].map(id => `<@${id}>`).join(', ');
  console.log(`[vcFlow] Match ${matchId} cancelled — VC timeout for: ${[...missing1, ...missing2].join(', ')}`);

  // Fetch lobby VC
  const lobbyVc = state.lobbyVcId
    ? guild.channels.cache.get(state.lobbyVcId) as VoiceChannel | undefined
    : undefined;

  // Move everyone from team VCs back to lobby (or disconnect)
  for (const vc of [team1Vc, team2Vc]) {
    if (!vc) continue;
    for (const [, member] of vc.members) {
      try {
        if (lobbyVc) await member.voice.setChannel(lobbyVc).catch(() => {});
        else         await member.voice.disconnect().catch(() => {});
      } catch {}
    }
  }

  // Delete team VCs
  await Promise.all([
    team1Vc?.delete('VC timeout — match cancelled').catch(() => {}),
    team2Vc?.delete('VC timeout — match cancelled').catch(() => {}),
  ]);

  // Cancel match in DB
  await supabase.from('eights_matches').update({ status: 'cancelled' }).eq('id', matchId);

  // Get current MMR for everyone
  const allIds = [...state.team1Ids, ...state.team2Ids];
  const { data: mmrRows } = await supabase
    .from('eights_player_mmr')
    .select('discord_id, mmr')
    .in('discord_id', allIds)
    .eq('guild_id', state.guildId);
  const mmrMap = new Map((mmrRows || []).map((r: any) => [r.discord_id as string, r.mmr as number]));

  // Re-create queue with all 8 players
  const { data: newQueue } = await supabase
    .from('eights_queues')
    .insert({
      guild_id:   state.guildId,
      channel_id: state.queueChannelId,
      game_id:    state.gameId,
      team_size:  state.teamSize,
      status:     'waiting',
    })
    .select('id')
    .single();

  if (!newQueue) return;

  await supabase.from('eights_queue_players').insert(
    allIds.map(id => ({
      queue_id:          newQueue.id,
      discord_id:        id,
      mmr_at_queue_time: mmrMap.get(id) ?? 1000,
    }))
  );

  // Post notice + immediately trigger team vote
  try {
    const ch = await guild.channels.fetch(state.queueChannelId) as TextChannel | null;
    if (!ch?.isTextBased()) return;

    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⚠️ Match Cancelled — VC Timeout')
          .setColor(0xEF4444)
          .setDescription(
            `${missingMentions} did not join their team voice channel in time.\n\n` +
            `All players have been moved back to ${lobbyVc ? `<#${lobbyVc.id}>` : 'the lobby'} ` +
            `and re-queued. Starting a new team vote now...`
          ),
      ],
    });

    // Immediately go to team vote (queue is already full)
    await state.onRequeue(newQueue.id, ch);

  } catch (err) {
    console.error('[vcFlow] Re-queue failed:', err);
  }
}

// ─── Clear VC phase if match is cancelled externally ─────────────────────────

export function clearVcPhase(matchId: string) {
  const state = vcPhases.get(matchId);
  if (state) {
    clearTimeout(state.timer);
    vcPhases.delete(matchId);
  }
}
