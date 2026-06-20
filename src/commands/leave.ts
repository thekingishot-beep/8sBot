import { ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { supabase } from '../supabase';
import { refreshQueueEmbed } from '../queueFlow';

export async function handleLeave(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const { data: queue } = await supabase
    .from('eights_queues').select('*')
    .eq('guild_id', interaction.guildId!)
    .eq('channel_id', interaction.channelId)
    .eq('status', 'waiting')
    .single();

  if (!queue) return interaction.editReply({ content: '❌ No active queue in this channel.' });

  const { data: existing } = await supabase
    .from('eights_queue_players').select('id')
    .eq('queue_id', queue.id).eq('discord_id', interaction.user.id).single();

  if (!existing) return interaction.editReply({ content: '⚠️ You\'re not in the queue.' });

  await supabase.from('eights_queue_players').delete().eq('id', existing.id);

  const { data: gameRow } = await supabase.from('games').select('name').eq('id', queue.game_id).single();
  const { data: config }  = await supabase.from('eights_channel_config').select('mmr_enabled')
    .eq('guild_id', interaction.guildId!).eq('channel_id', interaction.channelId).single();

  await refreshQueueEmbed(
    interaction.channel as TextChannel,
    queue.id,
    queue.team_size,
    gameRow?.name || 'Queue',
    config?.mmr_enabled ?? true,
    queue.message_id
  );

  await interaction.editReply({ content: '✅ You left the queue.' });
}
