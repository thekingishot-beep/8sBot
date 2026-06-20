import {
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  EmbedBuilder,
} from 'discord.js';
import { supabase } from './supabase';
import { getMmrMap, MMR_START, snakeTeam } from './mmr';
import { buildMapVoteEmbed } from './queueEmbed';
import { getMapPool, pickRandomMaps } from './mapPool';

const AUTO_PICK_SECONDS = 90;

interface CaptainDraftState {
  queueId:        string;
  guildId:        string;
  gameId:         string | null;
  captain1Id:     string;
  captain2Id:     string;
  team1:          Array<{ discord_id: string; profile_id: string | null }>;
  team2:          Array<{ discord_id: string; profile_id: string | null }>;
  remaining:      Array<{ discord_id: string; profile_id: string | null }>;
  pickOrder:      Array<1 | 2>;
  currentPick:    number;  // index into pickOrder
  mmrEnabled:     boolean;
  mmrMap:         Record<string, number>;
  channel:        any;     // TextChannel
  voteMsg:        Message;
  autoPickTimer?: ReturnType<typeof setTimeout>;
}

// keyed by queueId
const drafts = new Map<string, CaptainDraftState>();

export function getDraft(queueId: string): CaptainDraftState | undefined {
  return drafts.get(queueId);
}

export async function startCaptainDraft(
  queue: any,
  players: Array<{ discord_id: string; profile_id: string | null }>,
  mmrEnabled: boolean,
  channel: any,
  voteMsg: Message
) {
  const mmrMap = await getMmrMap(players.map(p => p.discord_id), queue.guild_id);

  // Pick captains: highest & second-highest MMR if enabled, else first two
  let sorted = [...players];
  if (mmrEnabled) {
    sorted.sort((a, b) => (mmrMap[b.discord_id] ?? MMR_START) - (mmrMap[a.discord_id] ?? MMR_START));
  }
  const [cap1, cap2, ...rest] = sorted;
  const remainingCount = rest.length;

  // Build pick order for remaining players (snake after the first two captains are set)
  const pickOrder: Array<1 | 2> = Array.from({ length: remainingCount }, (_, i) => snakeTeam(i));

  const state: CaptainDraftState = {
    queueId:     queue.id,
    guildId:     queue.guild_id,
    gameId:      queue.game_id,
    captain1Id:  cap1.discord_id,
    captain2Id:  cap2.discord_id,
    team1:       [cap1],
    team2:       [cap2],
    remaining:   rest,
    pickOrder,
    currentPick: 0,
    mmrEnabled,
    mmrMap,
    channel,
    voteMsg,
  };
  drafts.set(queue.id, state);

  await renderDraftEmbed(state);
  scheduleAutoPick(state);
}

export async function handleCaptainPickButton(interaction: ButtonInteraction, pickedDiscordId: string) {
  await interaction.deferUpdate();

  // Find which queue this belongs to by channel
  const { data: queue } = await supabase
    .from('eights_queues')
    .select('id')
    .eq('channel_id', interaction.channelId)
    .eq('guild_id', interaction.guildId!)
    .in('status', ['voting_teams', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!queue) return;
  const state = drafts.get(queue.id);
  if (!state) return;

  const whoShouldPick = state.pickOrder[state.currentPick] === 1 ? state.captain1Id : state.captain2Id;
  if (interaction.user.id !== whoShouldPick) {
    await interaction.followUp({ content: `❌ It's not your turn to pick.`, ephemeral: true });
    return;
  }

  makePick(state, pickedDiscordId);
}

function makePick(state: CaptainDraftState, discordId: string) {
  if (state.autoPickTimer) clearTimeout(state.autoPickTimer);

  const pickedIdx = state.remaining.findIndex(p => p.discord_id === discordId);
  if (pickedIdx === -1) return; // already picked or invalid

  const [picked] = state.remaining.splice(pickedIdx, 1);
  const pickTeam = state.pickOrder[state.currentPick];
  (pickTeam === 1 ? state.team1 : state.team2).push(picked);
  state.currentPick++;

  if (state.remaining.length === 0) {
    finalizeDraft(state);
  } else {
    renderDraftEmbed(state);
    scheduleAutoPick(state);
  }
}

function scheduleAutoPick(state: CaptainDraftState) {
  state.autoPickTimer = setTimeout(() => {
    if (state.remaining.length === 0) return;
    // Auto-pick: highest MMR remaining player
    const sorted = [...state.remaining].sort(
      (a, b) => (state.mmrMap[b.discord_id] ?? MMR_START) - (state.mmrMap[a.discord_id] ?? MMR_START)
    );
    makePick(state, sorted[0].discord_id);
  }, AUTO_PICK_SECONDS * 1000);
}

async function renderDraftEmbed(state: CaptainDraftState) {
  const currentCaptainId = state.pickOrder[state.currentPick] === 1 ? state.captain1Id : state.captain2Id;
  const teamLabel = state.pickOrder[state.currentPick] === 1 ? 'Team 1' : 'Team 2';

  const embed = new EmbedBuilder()
    .setTitle('👑 Captain Pick — Snake Draft')
    .setColor(0xF59E0B)
    .setDescription(`<@${currentCaptainId}> is picking for **${teamLabel}**\n*Auto-picks after ${AUTO_PICK_SECONDS}s*`)
    .addFields(
      {
        name: '🔵 Team 1',
        value: state.team1.map((p, i) => i === 0 ? `**Captain** <@${p.discord_id}>` : `<@${p.discord_id}>`).join('\n') || '—',
        inline: true,
      },
      {
        name: '🔴 Team 2',
        value: state.team2.map((p, i) => i === 0 ? `**Captain** <@${p.discord_id}>` : `<@${p.discord_id}>`).join('\n') || '—',
        inline: true,
      },
    );

  if (state.mmrEnabled) {
    embed.setFooter({ text: `MMR enabled — snake draft order` });
  }

  // Build pick buttons (max 5 per row, Discord limit is 5 rows)
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const chunks = chunkArray(state.remaining, 5);
  for (const chunk of chunks.slice(0, 5)) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const p of chunk) {
      const mmr = state.mmrEnabled ? ` (${state.mmrMap[p.discord_id] ?? MMR_START})` : '';
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`captain_pick_${p.discord_id}`)
          .setLabel(`<@${p.discord_id}>${mmr}`)
          .setStyle(ButtonStyle.Secondary)
      );
    }
    rows.push(row);
  }

  await state.voteMsg.edit({ embeds: [embed], components: rows });
}

async function finalizeDraft(state: CaptainDraftState) {
  drafts.delete(state.queueId);

  const pool = await getMapPool(state.gameId);
  const mapOptions = pickRandomMaps(pool, 4);

  if (mapOptions.length === 0) {
    const { startMatchFromTeams } = await import('./queueFlow');
    await startMatchFromTeams(state.queueId, state.team1, state.team2, 'TBD', 'TBD', 'captains', state.voteMsg);
    return;
  }

  await supabase.from('eights_queues').update({
    map_options: mapOptions,
    status: 'voting_map',
  }).eq('id', state.queueId);

  const { embed: mapEmbed, row: mapRow } = buildMapVoteEmbed(mapOptions);
  await state.voteMsg.edit({
    content: `🗺️ Teams set! Now vote for the map — **60s**`,
    embeds: [mapEmbed],
    components: [mapRow],
  });

  // Store teams in queue for the map vote resolver to access
  await supabase.from('eights_queues').update({
    captain_teams: {
      team1: state.team1,
      team2: state.team2,
    },
  }).eq('id', state.queueId);

  setTimeout(async () => {
    const { resolveCaptainMapVote } = await import('./queueFlow');
    await resolveCaptainMapVote(state.queueId, state.team1, state.team2, mapOptions, state.voteMsg);
  }, 60_000);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
