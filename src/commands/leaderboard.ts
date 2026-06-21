import { ChatInputCommandInteraction, ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';
import { supabase } from '../supabase';
import { buildLeaderboardEmbed, LbType } from '../queueEmbed';

const PAGE_SIZE = 10;

async function fetchAllLeaderboard(guildId: string, type: LbType) {
  const { data: mmrRows } = await supabase
    .from('eights_player_mmr')
    .select('discord_id, discord_username, mmr')
    .eq('guild_id', guildId);

  // Use eights_mmr_history (explicit won boolean) — reliable source for W/L
  const { data: historyRows } = await supabase
    .from('eights_mmr_history')
    .select('discord_id, won')
    .eq('guild_id', guildId);

  const statsMap: Record<string, { wins: number; games: number }> = {};
  for (const row of (historyRows || [])) {
    const id = row.discord_id;
    if (!statsMap[id]) statsMap[id] = { wins: 0, games: 0 };
    statsMap[id].games++;
    if (row.won) statsMap[id].wins++;
  }

  const merged = (mmrRows || []).map(r => ({
    discordId:   r.discord_id,
    displayName: r.discord_username || `Player ${r.discord_id.slice(-4)}`,
    mmr:         r.mmr,
    wins:        statsMap[r.discord_id]?.wins  ?? 0,
    losses:      (statsMap[r.discord_id]?.games ?? 0) - (statsMap[r.discord_id]?.wins ?? 0),
    games:       statsMap[r.discord_id]?.games ?? 0,
    winRate:     statsMap[r.discord_id]?.games
      ? statsMap[r.discord_id].wins / statsMap[r.discord_id].games
      : 0,
  })).filter(r => r.games > 0 || r.mmr !== 1000);

  if (type === 'mmr')     merged.sort((a, b) => b.mmr - a.mmr);
  if (type === 'winrate') merged.sort((a, b) => b.winRate - a.winRate || b.games - a.games);
  if (type === 'wins')    merged.sort((a, b) => b.wins - a.wins || b.mmr - a.mmr);
  if (type === 'games')   merged.sort((a, b) => b.games - a.games || b.mmr - a.mmr);

  return merged;
}

function paginateLeaderboard(all: ReturnType<typeof fetchAllLeaderboard> extends Promise<infer T> ? T : never, page: number) {
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const safePage   = Math.min(Math.max(1, page), totalPages);
  return { entries: all.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), totalPages, page: safePage };
}

export async function handleLeaderboard(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const guildId = interaction.guildId!;
  const { data: config } = await supabase
    .from('eights_channel_config').select('mmr_enabled, game_id').eq('guild_id', guildId).limit(1).single();
  const { data: gameRow } = config?.game_id
    ? await supabase.from('games').select('name').eq('id', config.game_id).single()
    : { data: null };

  const all = await fetchAllLeaderboard(guildId, 'mmr');
  if (all.length === 0) return interaction.editReply({ content: '📊 No players yet. Play some matches first!' });
  const { entries, totalPages, page } = paginateLeaderboard(all, 1);
  const { embed, rows } = buildLeaderboardEmbed(entries, page, totalPages, 'mmr', gameRow?.name, config?.mmr_enabled);
  await interaction.editReply({ embeds: [embed], components: rows });
}

// Called from index.ts for leaderboard pagination buttons
export async function handleLeaderboardButton(interaction: ButtonInteraction) {
  await interaction.deferUpdate();

  // customId format: lb_next_2_mmr / lb_prev_2_mmr / lb_first_2_mmr / lb_last_2_mmr
  const parts    = interaction.customId.split('_');
  const action   = parts[1] as 'prev' | 'next' | 'first' | 'last';
  const currPage = parseInt(parts[2]) || 1;
  const type     = (parts[3] as LbType) || 'mmr';

  const guildId = interaction.guildId!;
  const { data: config } = await supabase
    .from('eights_channel_config').select('mmr_enabled, game_id').eq('guild_id', guildId).limit(1).single();
  const { data: gameRow } = config?.game_id
    ? await supabase.from('games').select('name').eq('id', config.game_id).single()
    : { data: null };

  const all        = await fetchAllLeaderboard(guildId, type);
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const targetPage = action === 'first' ? 1
    : action === 'last'  ? totalPages
    : action === 'next'  ? Math.min(currPage + 1, totalPages)
    : Math.max(currPage - 1, 1);
  const { entries: pageEntries, page } = paginateLeaderboard(all, targetPage);
  const { embed, rows } = buildLeaderboardEmbed(pageEntries, page, totalPages, type, gameRow?.name, config?.mmr_enabled);
  await interaction.message.edit({ embeds: [embed], components: rows });
}

// Called from index.ts for leaderboard type dropdown
export async function handleLeaderboardTypeSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();

  // customId: lb_type_2
  const currPage = parseInt(interaction.customId.split('_')[2]) || 1;
  const type     = interaction.values[0] as LbType;
  const guildId  = interaction.guildId!;

  const { data: config } = await supabase
    .from('eights_channel_config').select('mmr_enabled, game_id').eq('guild_id', guildId).limit(1).single();
  const { data: gameRow } = config?.game_id
    ? await supabase.from('games').select('name').eq('id', config.game_id).single()
    : { data: null };

  const all = await fetchAllLeaderboard(guildId, type);
  const { entries, totalPages, page } = paginateLeaderboard(all, 1);
  const { embed, rows } = buildLeaderboardEmbed(entries, page, totalPages, type, gameRow?.name, config?.mmr_enabled);
  await interaction.message.edit({ embeds: [embed], components: rows });
}
