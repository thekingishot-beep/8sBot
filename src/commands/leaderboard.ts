import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { supabase } from '../supabase';

export async function handleLeaderboard(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const guildId = interaction.guildId!;

  // Fetch all completed match players for this guild
  const { data: rows } = await supabase
    .from('eights_match_players')
    .select('discord_id, team, eights_matches!inner(winner_team, status, guild_id)')
    .eq('eights_matches.guild_id', guildId)
    .eq('eights_matches.status', 'completed');

  const statsMap: Record<string, { wins: number; total: number }> = {};
  for (const row of (rows || []) as any[]) {
    const id = row.discord_id;
    if (!statsMap[id]) statsMap[id] = { wins: 0, total: 0 };
    statsMap[id].total++;
    if (row.team === row.eights_matches?.winner_team) statsMap[id].wins++;
  }

  const sorted = Object.entries(statsMap)
    .map(([id, s]) => ({ id, ...s, winRate: s.total > 0 ? (s.wins / s.total) * 100 : 0 }))
    .filter(s => s.total >= 3) // minimum 3 matches to appear
    .sort((a, b) => b.winRate - a.winRate || b.wins - a.wins)
    .slice(0, 10);

  if (sorted.length === 0) {
    return interaction.editReply({ content: '📊 No completed matches yet. Play some games first!' });
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = sorted.map((s, i) =>
    `${medals[i] || `**${i + 1}.**`} <@${s.id}> — **${s.winRate.toFixed(0)}%** WR (${s.wins}W / ${s.total - s.wins}L)`
  );

  const embed = new EmbedBuilder()
    .setTitle('🏆 8sBot Leaderboard')
    .setColor(0xF59E0B)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Minimum 3 matches · Sorted by win rate' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
