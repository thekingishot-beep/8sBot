import { ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../supabase';
import { buildQueueEmbed } from '../queueEmbed';

export async function handleLeave(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const guildId   = interaction.guildId!;
  const channelId = interaction.channelId;
  const discordId = interaction.user.id;

  const { data: queue } = await supabase
    .from('eights_queues')
    .select('*')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .eq('status', 'waiting')
    .single();

  if (!queue) {
    return interaction.editReply({ content: '❌ No active queue in this channel.' });
  }

  const { data: existing } = await supabase
    .from('eights_queue_players')
    .select('id')
    .eq('queue_id', queue.id)
    .eq('discord_id', discordId)
    .single();

  if (!existing) {
    return interaction.editReply({ content: '⚠️ You\'re not in the queue.' });
  }

  await supabase.from('eights_queue_players').delete().eq('id', existing.id);

  const { data: players } = await supabase
    .from('eights_queue_players')
    .select('discord_id')
    .eq('queue_id', queue.id);

  const playerTags = (players || []).map(p => `<@${p.discord_id}>`);
  const embed = buildQueueEmbed(playerTags, queue.team_size);

  const channel = interaction.channel;
  if (channel && queue.message_id) {
    try {
      const msg = await (channel as any).messages.fetch(queue.message_id);
      await msg.edit({ embeds: [embed] });
    } catch { /* message may have been deleted */ }
  }

  await interaction.editReply({ content: '✅ You left the queue.' });
}
