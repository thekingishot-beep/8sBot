import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { supabase } from '../supabase';

export async function handleStats(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const targetUser = interaction.options.getUser('player') ?? interaction.user;
  const discordId  = targetUser.id;

  // Find linked ScrimCenter profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, username, display_name')
    .eq('discord_id', discordId)
    .single();

  // Pull all match_player rows for this discord user
  const { data: matchPlayers } = await supabase
    .from('eights_match_players')
    .select('team, match_id, eights_matches(winner_team, status, map, mode, created_at)')
    .eq('discord_id', discordId);

  const completed = ((matchPlayers || []) as any[]).filter(mp => mp.eights_matches?.status === 'completed');
  const wins   = completed.filter(mp => mp.team === mp.eights_matches?.winner_team).length;
  const losses = completed.length - wins;
  const winRate = completed.length > 0 ? Math.round((wins / completed.length) * 100) : 0;

  const displayName = profile?.display_name || profile?.username || targetUser.username;

  const embed = new EmbedBuilder()
    .setTitle(`📊 8sBot Stats — ${displayName}`)
    .setColor(0x3B82F6)
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: 'Matches',  value: String(completed.length), inline: true },
      { name: 'Wins',     value: String(wins),             inline: true },
      { name: 'Losses',   value: String(losses),           inline: true },
      { name: 'Win Rate', value: `${winRate}%`,            inline: true },
    );

  if (!profile) {
    embed.setFooter({ text: '⚠️ Discord not linked to a ScrimCenter account — stats may be incomplete.' });
  }

  await interaction.editReply({ embeds: [embed] });
}
