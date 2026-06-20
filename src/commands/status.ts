import { ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../supabase';
import { buildQueueEmbed } from '../queueEmbed';

export async function handleStatus(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const { data: queue } = await supabase
    .from('eights_queues')
    .select('*')
    .eq('guild_id', interaction.guildId!)
    .eq('channel_id', interaction.channelId)
    .eq('status', 'waiting')
    .single();

  if (!queue) {
    return interaction.editReply({ content: '📋 No active queue in this channel right now.' });
  }

  const { data: players } = await supabase
    .from('eights_queue_players')
    .select('discord_id')
    .eq('queue_id', queue.id);

  const playerTags = (players || []).map(p => `<@${p.discord_id}>`);
  const embed = buildQueueEmbed(playerTags, queue.team_size);

  await interaction.editReply({ embeds: [embed] });
}
