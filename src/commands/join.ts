import { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { supabase } from '../supabase';
import { buildQueueEmbed } from '../queueEmbed';
import { handleQueueFull } from '../queueFlow';

export async function handleJoin(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const guildId   = interaction.guildId!;
  const channelId = interaction.channelId;
  const discordId = interaction.user.id;
  const discordTag = `<@${discordId}>`;

  // 1. Check channel is configured
  const { data: config } = await supabase
    .from('eights_channel_config')
    .select('*')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .single();

  if (!config) {
    return interaction.editReply({ content: '❌ This channel is not set up for 8sBot. Ask an admin to run `/8s-setup`.' });
  }

  // 2. Get or create waiting queue for this channel
  let { data: queue } = await supabase
    .from('eights_queues')
    .select('*')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .eq('status', 'waiting')
    .single();

  if (!queue) {
    const { data: newQueue, error } = await supabase
      .from('eights_queues')
      .insert({
        guild_id: guildId,
        channel_id: channelId,
        game_id: config.game_id,
        team_size: config.team_size,
        status: 'waiting',
      })
      .select()
      .single();

    if (error || !newQueue) {
      return interaction.editReply({ content: '❌ Failed to create queue. Try again.' });
    }
    queue = newQueue;
  }

  // 3. Check player isn't already in queue
  const { data: existing } = await supabase
    .from('eights_queue_players')
    .select('id')
    .eq('queue_id', queue.id)
    .eq('discord_id', discordId)
    .single();

  if (existing) {
    return interaction.editReply({ content: '⚠️ You\'re already in the queue.' });
  }

  // 4. Link to ScrimCenter profile if they have one
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('discord_id', discordId)
    .single();

  // 5. Add to queue
  await supabase.from('eights_queue_players').insert({
    queue_id: queue.id,
    discord_id: discordId,
    profile_id: profile?.id ?? null,
  });

  // 6. Fetch all current players
  const { data: players } = await supabase
    .from('eights_queue_players')
    .select('discord_id')
    .eq('queue_id', queue.id);

  const playerTags = (players || []).map(p => `<@${p.discord_id}>`);
  const total = config.team_size * 2;

  // 7. Update queue embed in channel
  const embed = buildQueueEmbed(playerTags, config.team_size);
  const channel = interaction.channel;
  if (channel && 'send' in channel) {
    if (queue.message_id) {
      try {
        const msg = await (channel as any).messages.fetch(queue.message_id);
        await msg.edit({ embeds: [embed] });
      } catch {
        const msg = await (channel as any).send({ embeds: [embed] });
        await supabase.from('eights_queues').update({ message_id: msg.id }).eq('id', queue.id);
      }
    } else {
      const msg = await (channel as any).send({ embeds: [embed] });
      await supabase.from('eights_queues').update({ message_id: msg.id }).eq('id', queue.id);
    }
  }

  await interaction.editReply({ content: `✅ You joined the queue! [${playerTags.length}/${total}]` });

  // 8. If queue is full, trigger team selection vote
  if (playerTags.length >= total) {
    await handleQueueFull(interaction, queue.id, config.team_size);
  }
}
