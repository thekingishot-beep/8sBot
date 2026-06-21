import { ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../supabase';
import { getPlayerMmr, getPlayerRank } from '../mmr';
import { buildStatsEmbed } from '../queueEmbed';

export async function handleStats(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const targetUser = interaction.options.getUser('player') ?? interaction.user;
  const discordId  = targetUser.id;
  const guildId    = interaction.guildId!;

  const { data: profile } = await supabase
    .from('profiles').select('id, username, display_name')
    .eq('discord_id', discordId).single();

  const displayName = profile?.display_name || profile?.username || targetUser.displayName;

  // Pull win/loss counts from history (explicit won boolean — reliable source)
  const { data: historyAll } = await supabase
    .from('eights_mmr_history')
    .select('won')
    .eq('discord_id', discordId)
    .eq('guild_id', guildId);

  const wins   = (historyAll || []).filter(h => h.won).length;
  const losses = (historyAll || []).filter(h => !h.won).length;

  // Pull MMR history for recent games
  const { data: mmrHistory } = await supabase
    .from('eights_mmr_history')
    .select('won, delta, created_at')
    .eq('discord_id', discordId)
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(6);

  const recentGames = (mmrHistory || []).map(h => ({
    won:       h.won,
    delta:     h.delta,
    createdAt: h.created_at,
  }));

  // MMR + rank
  const { data: config } = await supabase
    .from('eights_channel_config').select('mmr_enabled, game_id')
    .eq('guild_id', guildId).limit(1).single();
  const mmrEnabled = config?.mmr_enabled ?? true;

  const mmr  = await getPlayerMmr(discordId, guildId);
  const rank = await getPlayerRank(discordId, guildId);

  const { data: gameRow } = config?.game_id
    ? await supabase.from('games').select('name').eq('id', config.game_id).single()
    : { data: null };

  const embed = buildStatsEmbed(
    displayName,
    targetUser.displayAvatarURL(),
    mmr,
    rank,
    wins,
    losses,
    recentGames,
    mmrEnabled,
    gameRow?.name
  );

  if (!profile) {
    embed.setFooter({ text: '⚠️ Not linked to a ScrimCenter account — link Discord in your profile for full tracking.' });
  }

  await interaction.editReply({ embeds: [embed] });
}
