import { ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../supabase';
import { MMR_MIN } from '../mmr';

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  const member = interaction.member as any;
  return !!(member?.permissions?.has?.('ManageChannels') || member?.permissions?.has?.('Administrator'));
}

export async function handleMmrSet(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  if (!isAdmin(interaction)) return interaction.editReply({ content: '❌ Admin only.' });

  const guildId    = interaction.guildId!;
  const targetUser = interaction.options.getUser('player', true);
  const newMmr     = interaction.options.getInteger('mmr', true);

  if (newMmr < MMR_MIN || newMmr > 9999) {
    return interaction.editReply({ content: `❌ MMR must be between ${MMR_MIN} and 9999.` });
  }

  const { data: existing } = await supabase
    .from('eights_player_mmr')
    .select('mmr')
    .eq('discord_id', targetUser.id)
    .eq('guild_id', guildId)
    .single();

  if (!existing) {
    return interaction.editReply({ content: `❌ ${targetUser.displayName} has no MMR record on this server yet.` });
  }

  const before = existing.mmr;
  const delta  = newMmr - before;

  await supabase.from('eights_player_mmr')
    .update({ mmr: newMmr, win_streak: 0, updated_at: new Date().toISOString() })
    .eq('discord_id', targetUser.id)
    .eq('guild_id', guildId);

  return interaction.editReply({
    content: `✅ Set **${targetUser.displayName}**'s MMR to **${newMmr}** (was ${before}, ${delta >= 0 ? '+' : ''}${delta})`,
  });
}

export async function handleVoidMatch(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  if (!isAdmin(interaction)) return interaction.editReply({ content: '❌ Admin only.' });

  const guildId     = interaction.guildId!;
  const matchNumber = interaction.options.getInteger('match_number', true);

  const { data: match } = await supabase
    .from('eights_matches')
    .select('id, status')
    .eq('guild_id', guildId)
    .eq('match_number', matchNumber)
    .single();

  if (!match) return interaction.editReply({ content: `❌ Match #${matchNumber} not found on this server.` });
  if (match.status === 'cancelled') return interaction.editReply({ content: `❌ Match #${matchNumber} is already voided.` });

  // Fetch history rows to revert MMR
  const { data: historyRows } = await supabase
    .from('eights_mmr_history')
    .select('discord_id, mmr_before')
    .eq('match_id', match.id);

  for (const h of (historyRows || [])) {
    await supabase.from('eights_player_mmr')
      .update({ mmr: h.mmr_before, win_streak: 0, updated_at: new Date().toISOString() })
      .eq('discord_id', h.discord_id)
      .eq('guild_id', guildId);
  }

  // Delete history rows and cancel the match
  await supabase.from('eights_mmr_history').delete().eq('match_id', match.id);
  await supabase.from('eights_matches').update({ status: 'cancelled', winner_team: null }).eq('id', match.id);

  return interaction.editReply({
    content: `✅ Match #${matchNumber} voided. MMR reverted for ${(historyRows || []).length} players.`,
  });
}
