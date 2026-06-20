import { ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { supabase } from './supabase';

export async function handleRemoveCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const guildId   = interaction.guildId!;
  const channelId = interaction.channelId;

  // Permission check: ManageChannels required
  const member = interaction.member as any;
  const hasPerms = member?.permissions?.has?.('ManageChannels');
  if (!hasPerms) {
    return interaction.editReply({ content: '❌ You need the **Manage Channels** permission to remove a queue.' });
  }

  const { data: config } = await supabase
    .from('eights_channel_config')
    .select('id')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .single();

  if (!config) {
    return interaction.editReply({ content: '⚠️ This channel has no 8sBot configuration to remove.' });
  }

  // Cancel any waiting queue and delete its embed
  const { data: queue } = await supabase
    .from('eights_queues')
    .select('id, message_id')
    .eq('guild_id', guildId)
    .eq('channel_id', channelId)
    .eq('status', 'waiting')
    .single();

  if (queue) {
    await supabase.from('eights_queues').update({ status: 'cancelled' }).eq('id', queue.id);

    if (queue.message_id) {
      try {
        const ch = interaction.channel as TextChannel;
        const msg = await ch.messages.fetch(queue.message_id);
        await msg.delete();
      } catch { /* message may already be gone */ }
    }
  }

  // Remove the channel config
  await supabase.from('eights_channel_config').delete().eq('id', config.id);

  await interaction.editReply({
    content: `✅ Queue configuration removed from <#${channelId}>. Run \`/8s-setup\` to reconfigure.`,
  });
}
