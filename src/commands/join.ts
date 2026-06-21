import { ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { supabase } from '../supabase';
import { refreshQueueEmbed, handleQueueFull, startFirstJoinTimerForQueue } from '../queueFlow';
import { touchMmrRow } from '../mmr';

export async function handleJoin(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const guildId   = interaction.guildId!;
  const channelId = interaction.channelId;
  const discordId = interaction.user.id;

  const { data: config } = await supabase
    .from('eights_channel_config').select('*')
    .eq('guild_id', guildId).eq('channel_id', channelId).single();

  if (!config) {
    return interaction.editReply({ content: '❌ This channel is not set up for 8sBot. Ask an admin to run `/8s-setup`.' });
  }

  let { data: queue } = await supabase
    .from('eights_queues').select('*')
    .eq('guild_id', guildId).eq('channel_id', channelId).eq('status', 'waiting').single();

  if (!queue) {
    const { data: newQueue } = await supabase
      .from('eights_queues')
      .insert({ guild_id: guildId, channel_id: channelId, game_id: config.game_id, team_size: config.team_size, status: 'waiting' })
      .select().single();
    if (!newQueue) return interaction.editReply({ content: '❌ Failed to create queue.' });
    queue = newQueue;
  }

  const { data: existing } = await supabase
    .from('eights_queue_players').select('id')
    .eq('queue_id', queue.id).eq('discord_id', discordId).single();

  if (existing) return interaction.editReply({ content: '⚠️ You\'re already in the queue.' });

  const { data: profile } = await supabase.from('profiles').select('id').eq('discord_id', discordId).single();
  const mmr = await touchMmrRow(discordId, guildId, interaction.user.username);

  await supabase.from('eights_queue_players').insert({
    queue_id:          queue.id,
    discord_id:        discordId,
    profile_id:        profile?.id ?? null,
    mmr_at_queue_time: mmr,
  });

  const { data: gameRow } = await supabase.from('games').select('name').eq('id', config.game_id).single();
  const gameName = gameRow?.name || 'Queue';
  const total    = config.team_size * 2;

  const channel = interaction.channel as TextChannel;
  const newMsgId = await refreshQueueEmbed(channel, queue.id, config.team_size, gameName, config.mmr_enabled, queue.message_id);
  if (newMsgId && newMsgId !== queue.message_id) {
    await supabase.from('eights_queues').update({ message_id: newMsgId }).eq('id', queue.id);
  }

  const { data: players } = await supabase
    .from('eights_queue_players').select('discord_id').eq('queue_id', queue.id);
  const count = (players || []).length;

  await interaction.editReply({ content: `✅ You joined the queue! [${count}/${total}]` });

  // Ping the configured role when one spot remains
  if (count === total - 1 && config.queue_ping_role_id) {
    try {
      await channel.send({ content: `<@&${config.queue_ping_role_id}> 🔔 Queue is at **${count}/${total}** — one spot left!` });
    } catch { /* non-fatal */ }
  }

  // Start first-join timer when player #1 enters via slash command
  if (count === 1) {
    startFirstJoinTimerForQueue({
      queueId:           queue.id,
      channelId,
      guildId,
      gameId:            config.game_id,
      teamSize:          config.team_size,
      displayName:       gameName,
      mmrEnabled:        config.mmr_enabled,
      inactivityMinutes: config.inactivity_minutes ?? 60,
      client:            interaction.client,
      currentMsgId:      newMsgId || queue.message_id,
    });
  }

  if (count >= total) {
    await handleQueueFull(channel, queue.id, config.team_size, gameName, config.mmr_enabled, newMsgId || queue.message_id);
  }
}
