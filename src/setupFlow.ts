import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ChannelSelectMenuInteraction,
  RoleSelectMenuInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  TextChannel,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { supabase } from './supabase';
import { buildQueueEmbed } from './queueEmbed';

interface SetupState {
  // Page 1
  channelId:          string | null;
  channelName:        string | null;
  gameId:             string | null;
  gameName:           string | null;
  teamSize:           number;
  resultsChannelId:   string | null;
  resultsChannelName: string | null;
  // Page 2
  staffRoleId:        string | null;
  staffRoleName:      string | null;
  inactivityMinutes:  number;
  queueName:          string | null;
  // Nav
  page: 1 | 2;
}

const pending = new Map<string, SetupState>();

function pendingKey(guildId: string, userId: string) {
  return `${guildId}-${userId}`;
}

// ─── Page 1 embed ─────────────────────────────────────────────────────────────

function buildPage1Embed(s: SetupState) {
  return new EmbedBuilder()
    .setTitle('⚙️ 8sBot Setup  (1/2 — Core)')
    .setColor(0x3B82F6)
    .setDescription('Configure the core settings for your queue channel.')
    .addFields(
      { name: '📺 Queue Channel',   value: s.channelName        ? `#${s.channelName}`        : '*Not selected*',              inline: true },
      { name: '🎮 Game',            value: s.gameName           || '*Not selected*',                                          inline: true },
      { name: '👥 Team Size',       value: `${s.teamSize}v${s.teamSize}`,                                                     inline: true },
      { name: '📣 Results Channel', value: s.resultsChannelName ? `#${s.resultsChannelName}` : '*Same as queue channel*',     inline: true },
    );
}

// ─── Page 2 embed ─────────────────────────────────────────────────────────────

function buildPage2Embed(s: SetupState) {
  return new EmbedBuilder()
    .setTitle('⚙️ 8sBot Setup  (2/2 — Advanced)')
    .setColor(0x8B5CF6)
    .setDescription('Optional fine-tuning. All fields have sensible defaults — you can skip any.')
    .addFields(
      { name: '🛡️ Staff Role',       value: s.staffRoleName || '*Not set — Manage Channels only*',                  inline: true },
      { name: '⏱️ Inactivity Timeout', value: s.inactivityMinutes === 0 ? 'Never' : `${s.inactivityMinutes} minutes`, inline: true },
      { name: '✏️ Queue Name',        value: s.queueName || `*Auto — uses game name*`,                               inline: true },
    );
}

// ─── Build page 1 components ──────────────────────────────────────────────────

async function buildPage1Components(guildId: string) {
  const { data: games } = await supabase.from('games').select('id, name').order('name');

  const channelRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('setup_channel')
      .setPlaceholder('Queue channel — where players type /join')
      .addChannelTypes(ChannelType.GuildText)
  );

  const gameRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('setup_game')
      .setPlaceholder('Select a game')
      .addOptions((games || []).map((g: any) => ({ label: g.name, value: g.id })))
  );

  const sizeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('setup_size')
      .setPlaceholder('Team size (default: 4v4)')
      .addOptions([
        { label: '2v2 (4 players)',  value: '2' },
        { label: '3v3 (6 players)',  value: '3' },
        { label: '4v4 (8 players)',  value: '4', default: true },
        { label: '5v5 (10 players)', value: '5' },
      ])
  );

  const resultsRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('setup_results_channel')
      .setPlaceholder('Results channel — winner cards post here (optional)')
      .addChannelTypes(ChannelType.GuildText)
  );

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('setup_next').setLabel('Next →').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  return [channelRow, gameRow, sizeRow, resultsRow, buttonRow];
}

// ─── Build page 2 components ──────────────────────────────────────────────────

function buildPage2Components() {
  const staffRow = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('setup_staff_role')
      .setPlaceholder('Staff role — who can Force Start / Cancel (optional)')
  );

  const inactivityRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('setup_inactivity')
      .setPlaceholder('Inactivity timeout (default: 60 min)')
      .addOptions([
        { label: '15 minutes', value: '15' },
        { label: '30 minutes', value: '30' },
        { label: '45 minutes', value: '45' },
        { label: '60 minutes (default)', value: '60', default: true },
        { label: '90 minutes', value: '90' },
        { label: '2 hours',    value: '120' },
        { label: '4 hours',    value: '240' },
        { label: 'Never',      value: '0' },
      ])
  );

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('setup_back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_queue_name').setLabel('✏️ Set Queue Name').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup_save').setLabel('💾 Save').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  return [staffRow, inactivityRow, buttonRow];
}

// ─── /8s-setup command ────────────────────────────────────────────────────────

export async function handleSetupCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const key = pendingKey(interaction.guildId!, interaction.user.id);
  pending.set(key, {
    channelId: null, channelName: null,
    gameId: null, gameName: null,
    teamSize: 4,
    resultsChannelId: null, resultsChannelName: null,
    staffRoleId: null, staffRoleName: null,
    inactivityMinutes: 60,
    queueName: null,
    page: 1,
  });

  const state = pending.get(key)!;
  const components = await buildPage1Components(interaction.guildId!);

  if (!components[1]) {
    return interaction.editReply({ content: '❌ No games found in ScrimCenter. Add games first at /admin.' });
  }

  await interaction.editReply({ embeds: [buildPage1Embed(state)], components });
}

// ─── Page 1 select handlers ───────────────────────────────────────────────────

export async function handleSetupChannelSelect(interaction: ChannelSelectMenuInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  if (!pending.has(key)) return;
  const state = pending.get(key)!;
  const channel = interaction.channels.first();
  state.channelId   = channel?.id ?? null;
  state.channelName = channel && 'name' in channel ? (channel.name ?? null) : null;
  await interaction.editReply({ embeds: [buildPage1Embed(state)] });
}

export async function handleSetupResultsChannelSelect(interaction: ChannelSelectMenuInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  if (!pending.has(key)) return;
  const state = pending.get(key)!;
  const channel = interaction.channels.first();
  state.resultsChannelId   = channel?.id ?? null;
  state.resultsChannelName = channel && 'name' in channel ? (channel.name ?? null) : null;
  await interaction.editReply({ embeds: [buildPage1Embed(state)] });
}

export async function handleSetupGameSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  if (!pending.has(key)) return;
  const state = pending.get(key)!;
  const { data: game } = await supabase.from('games').select('name').eq('id', interaction.values[0]).single();
  state.gameId   = interaction.values[0];
  state.gameName = game?.name ?? interaction.values[0];
  await interaction.editReply({ embeds: [buildPage1Embed(state)] });
}

export async function handleSetupSizeSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  if (!pending.has(key)) return;
  const state = pending.get(key)!;
  state.teamSize = parseInt(interaction.values[0]);
  await interaction.editReply({ embeds: [buildPage1Embed(state)] });
}

// ─── Page 2 select handlers ───────────────────────────────────────────────────

export async function handleSetupStaffRoleSelect(interaction: RoleSelectMenuInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  if (!pending.has(key)) return;
  const state = pending.get(key)!;
  const role = interaction.roles.first();
  state.staffRoleId   = role?.id ?? null;
  state.staffRoleName = role?.name ?? null;
  await interaction.editReply({ embeds: [buildPage2Embed(state)], components: buildPage2Components() });
}

export async function handleSetupInactivitySelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  if (!pending.has(key)) return;
  const state = pending.get(key)!;
  state.inactivityMinutes = parseInt(interaction.values[0]);
  await interaction.editReply({ embeds: [buildPage2Embed(state)], components: buildPage2Components() });
}

// ─── Page navigation buttons ──────────────────────────────────────────────────

export async function handleSetupNext(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  const state = pending.get(key);
  if (!state) return interaction.followUp({ content: '❌ Session expired. Run `/8s-setup` again.', ephemeral: true });
  if (!state.channelId) return interaction.followUp({ content: '⚠️ Select a queue channel first.', ephemeral: true });
  if (!state.gameId)    return interaction.followUp({ content: '⚠️ Select a game first.', ephemeral: true });
  state.page = 2;
  await interaction.editReply({ embeds: [buildPage2Embed(state)], components: buildPage2Components() });
}

export async function handleSetupBack(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  const state = pending.get(key);
  if (!state) return interaction.followUp({ content: '❌ Session expired. Run `/8s-setup` again.', ephemeral: true });
  state.page = 1;
  const components = await buildPage1Components(interaction.guildId!);
  await interaction.editReply({ embeds: [buildPage1Embed(state)], components });
}

// ─── Queue name modal ─────────────────────────────────────────────────────────

export async function handleSetupQueueNameButton(interaction: ButtonInteraction) {
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  if (!pending.has(key)) return interaction.reply({ content: '❌ Session expired.', ephemeral: true });

  const modal = new ModalBuilder()
    .setCustomId('setup_queue_name_modal')
    .setTitle('Set Queue Name');

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('queue_name_input')
        .setLabel('Queue name shown in the embed title')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. APL 8s Queue')
        .setMaxLength(50)
        .setRequired(false)
    )
  );

  await interaction.showModal(modal);
}

export async function handleSetupQueueNameModal(interaction: ModalSubmitInteraction) {
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  const state = pending.get(key);
  if (!state) return interaction.reply({ content: '❌ Session expired.', ephemeral: true });

  const name = interaction.fields.getTextInputValue('queue_name_input').trim();
  state.queueName = name || null;

  await interaction.reply({
    content: name ? `✅ Queue name set to **${name}**. Click **Save** when ready.` : '✅ Queue name cleared — will use game name.',
    ephemeral: true,
  });
}

// ─── Save ─────────────────────────────────────────────────────────────────────

export async function handleSetupSave(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const key   = pendingKey(interaction.guildId!, interaction.user.id);
  const state = pending.get(key);

  if (!state)           return interaction.followUp({ content: '❌ Session expired. Run `/8s-setup` again.', ephemeral: true });
  if (!state.channelId) return interaction.followUp({ content: '⚠️ Go back and select a queue channel.', ephemeral: true });
  if (!state.gameId)    return interaction.followUp({ content: '⚠️ Go back and select a game.', ephemeral: true });

  const { error } = await supabase.from('eights_channel_config').upsert({
    guild_id:            interaction.guildId!,
    channel_id:          state.channelId,
    game_id:             state.gameId,
    team_size:           state.teamSize,
    results_channel_id:  state.resultsChannelId,
    staff_role_id:       state.staffRoleId,
    inactivity_minutes:  state.inactivityMinutes,
    queue_name:          state.queueName,
  }, { onConflict: 'guild_id,channel_id' });

  pending.delete(key);

  if (error) return interaction.followUp({ content: `❌ Failed to save: ${error.message}`, ephemeral: true });

  const displayName = state.queueName || state.gameName || 'Queue';

  const successEmbed = new EmbedBuilder()
    .setTitle('✅ 8sBot Configured!')
    .setColor(0x10B981)
    .addFields(
      { name: '📺 Queue Channel',     value: `<#${state.channelId}>`,                                               inline: true },
      { name: '🎮 Game',              value: state.gameName || '—',                                                 inline: true },
      { name: '👥 Team Size',         value: `${state.teamSize}v${state.teamSize}`,                                 inline: true },
      { name: '📣 Results Channel',   value: state.resultsChannelId ? `<#${state.resultsChannelId}>` : 'Queue channel', inline: true },
      { name: '🛡️ Staff Role',        value: state.staffRoleName ? `@${state.staffRoleName}` : 'Manage Channels',  inline: true },
      { name: '⏱️ Inactivity',         value: state.inactivityMinutes === 0 ? 'Never' : `${state.inactivityMinutes} min`, inline: true },
      { name: '✏️ Queue Name',         value: state.queueName || `${state.gameName} (auto)`,                        inline: true },
    )
    .setDescription(`Queue embed posted in <#${state.channelId}>. Players can click **Join Queue** to enter!`);

  await interaction.editReply({ embeds: [successEmbed], components: [] });

  // Auto-post queue embed to the configured channel
  try {
    const queueChannel = await interaction.client.channels.fetch(state.channelId) as TextChannel;
    if (queueChannel && 'send' in queueChannel) {
      const { embed, row } = buildQueueEmbed([], state.teamSize, displayName, true);
      const msg = await queueChannel.send({ embeds: [embed], components: [row] });

      const { data: existing } = await supabase
        .from('eights_queues').select('id')
        .eq('guild_id', interaction.guildId!).eq('channel_id', state.channelId).eq('status', 'waiting').single();

      if (!existing) {
        await supabase.from('eights_queues').insert({
          guild_id: interaction.guildId!, channel_id: state.channelId,
          game_id: state.gameId, team_size: state.teamSize,
          status: 'waiting', message_id: msg.id,
        });
      } else {
        await supabase.from('eights_queues').update({ message_id: msg.id }).eq('id', existing.id);
      }
    }
  } catch (err) {
    console.error('Failed to auto-post queue embed:', err);
  }
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

export async function handleSetupCancel(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  pending.delete(key);
  await interaction.editReply({
    embeds: [new EmbedBuilder().setTitle('❌ Setup cancelled').setColor(0xEF4444)],
    components: [],
  });
}
