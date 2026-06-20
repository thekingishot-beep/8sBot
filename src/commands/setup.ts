import { ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { supabase } from '../supabase';

export async function handleSetup(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const member = interaction.member;
  if (!member || !(member as any).permissions?.has?.(PermissionFlagsBits.ManageGuild)) {
    return interaction.editReply({ content: '❌ You need **Manage Server** permission to run this command.' });
  }

  const channel = interaction.options.getChannel('channel', true);
  const gameId  = interaction.options.getString('game_id') || null;
  const size    = interaction.options.getInteger('team_size') ?? 4;

  const { error } = await supabase
    .from('eights_channel_config')
    .upsert({
      guild_id:   interaction.guildId!,
      channel_id: channel.id,
      game_id:    gameId,
      team_size:  size,
    }, { onConflict: 'guild_id,channel_id' });

  if (error) {
    return interaction.editReply({ content: `❌ Setup failed: ${error.message}` });
  }

  await interaction.editReply({
    content: `✅ <#${channel.id}> is now an 8sBot queue channel!\n**Team size:** ${size}v${size}\n**Game ID:** ${gameId || 'default'}`,
  });
}
