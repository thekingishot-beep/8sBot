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
    .select('discord_id, mmr_at_queue_time')
    .eq('queue_id', queue.id);

  const { data: config } = await supabase
    .from('eights_channel_config')
    .select('mmr_enabled, game_id')
    .eq('guild_id', interaction.guildId!)
    .eq('channel_id', interaction.channelId)
    .single();

  const { data: gameRow } = config?.game_id
    ? await supabase.from('games').select('name').eq('id', config.game_id).single()
    : { data: null };

  const playerList = (players || []).map(p => ({
    tag: `<@${p.discord_id}>`,
    mmr: p.mmr_at_queue_time,
  }));

  const { embed } = buildQueueEmbed(playerList, queue.team_size, gameRow?.name || 'Queue', config?.mmr_enabled ?? true);

  await interaction.editReply({ embeds: [embed] });
}
