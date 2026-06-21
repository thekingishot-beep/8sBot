import { ChatInputCommandInteraction } from 'discord.js';
import { supabase } from '../supabase';

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  const member = interaction.member as any;
  return !!(member?.permissions?.has?.('ManageChannels') || member?.permissions?.has?.('Administrator'));
}

export async function handleConfig8s(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  if (!isAdmin(interaction)) return interaction.editReply({ content: '❌ Admin only.' });

  const guildId = interaction.guildId!;
  const sub     = interaction.options.getSubcommand(true);

  // ── Ping role ──────────────────────────────────────────────────────────────
  if (sub === 'ping-role') {
    const role = interaction.options.getRole('role');
    const channelOpt = interaction.options.getChannel('channel');
    const channelId  = channelOpt?.id ?? interaction.channelId;

    await supabase.from('eights_channel_config')
      .update({ queue_ping_role_id: role?.id ?? null })
      .eq('guild_id', guildId)
      .eq('channel_id', channelId);

    return interaction.editReply({
      content: role
        ? `✅ Queue ping role set to <@&${role.id}> for <#${channelId}>. They'll be pinged when 1 spot remains.`
        : `✅ Queue ping role cleared for <#${channelId}>.`,
    });
  }

  // Fetch current rank_roles for all rank-roles subcommands
  const { data: config } = await supabase
    .from('eights_channel_config')
    .select('rank_roles')
    .eq('guild_id', guildId)
    .limit(1)
    .single();

  const rankRoles: Array<{ minMmr: number; roleId: string; label: string }> =
    config?.rank_roles || [];

  // ── Rank roles: add ────────────────────────────────────────────────────────
  if (sub === 'rank-roles-add') {
    const minMmr = interaction.options.getInteger('min_mmr', true);
    const role   = interaction.options.getRole('role', true);
    const label  = interaction.options.getString('label') || role.name;

    const updated = rankRoles.filter(r => r.roleId !== role.id);
    updated.push({ minMmr, roleId: role.id, label });
    updated.sort((a, b) => a.minMmr - b.minMmr);

    await supabase.from('eights_channel_config')
      .update({ rank_roles: updated })
      .eq('guild_id', guildId);

    return interaction.editReply({
      content: `✅ Rank role **${label}** set for **${minMmr}+ MMR** → <@&${role.id}>`,
    });
  }

  // ── Rank roles: remove ────────────────────────────────────────────────────
  if (sub === 'rank-roles-remove') {
    const role    = interaction.options.getRole('role', true);
    const updated = rankRoles.filter(r => r.roleId !== role.id);

    await supabase.from('eights_channel_config')
      .update({ rank_roles: updated })
      .eq('guild_id', guildId);

    return interaction.editReply({ content: `✅ Removed <@&${role.id}> from rank roles.` });
  }

  // ── Rank roles: list ──────────────────────────────────────────────────────
  if (sub === 'rank-roles-list') {
    if (rankRoles.length === 0) {
      return interaction.editReply({ content: '📋 No rank roles configured. Use `/8s-config rank-roles-add` to set them up.' });
    }
    const lines = [...rankRoles]
      .sort((a, b) => a.minMmr - b.minMmr)
      .map(r => `<@&${r.roleId}> — **${r.label}** (${r.minMmr}+ MMR)`);
    return interaction.editReply({ content: `📋 **Rank Roles:**\n${lines.join('\n')}` });
  }

  // ── Rank roles: clear ─────────────────────────────────────────────────────
  if (sub === 'rank-roles-clear') {
    await supabase.from('eights_channel_config')
      .update({ rank_roles: [] })
      .eq('guild_id', guildId);
    return interaction.editReply({ content: '✅ All rank roles cleared.' });
  }
}
