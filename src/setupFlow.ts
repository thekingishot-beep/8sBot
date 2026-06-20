import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ChannelSelectMenuInteraction,
  ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from 'discord.js';
import { supabase } from './supabase';

// Pending config state per user (in-memory, fine for persistent Railway process)
const pending = new Map<string, {
  channelId: string | null;
  channelName: string | null;
  gameId: string | null;
  gameName: string | null;
  teamSize: number;
}>();

function pendingKey(guildId: string, userId: string) {
  return `${guildId}-${userId}`;
}

function buildSetupEmbed(state: { channelName: string | null; gameName: string | null; teamSize: number }) {
  return new EmbedBuilder()
    .setTitle('⚙️ 8sBot Channel Setup')
    .setColor(0x3B82F6)
    .setDescription('Configure a channel for the 8s queue. Select all options below then click **Save**.')
    .addFields(
      { name: '📺 Channel',   value: state.channelName ? `#${state.channelName}` : '*Not selected*', inline: true },
      { name: '🎮 Game',      value: state.gameName    || '*Not selected*',                          inline: true },
      { name: '👥 Team Size', value: `${state.teamSize}v${state.teamSize}`,                          inline: true },
    );
}

export async function handleSetupCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const userId  = interaction.user.id;
  const guildId = interaction.guildId!;

  // Fetch games from Supabase
  const { data: games } = await supabase.from('games').select('id, name').order('name');
  if (!games || games.length === 0) {
    return interaction.editReply({ content: '❌ No games found in ScrimCenter. Add games first at /admin.' });
  }

  // Init pending state
  const key = pendingKey(guildId, userId);
  pending.set(key, { channelId: null, channelName: null, gameId: null, gameName: null, teamSize: 4 });

  const state = pending.get(key)!;

  // Row 1: Channel select
  const channelRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('setup_channel')
      .setPlaceholder('Select a channel for the queue')
      .addChannelTypes(ChannelType.GuildText)
  );

  // Row 2: Game select (from DB)
  const gameRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('setup_game')
      .setPlaceholder('Select a game')
      .addOptions(games.map((g: any) => ({ label: g.name, value: g.id })))
  );

  // Row 3: Team size select
  const sizeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('setup_size')
      .setPlaceholder('Team size (default: 4v4)')
      .addOptions([
        { label: '2v2 (4 players)', value: '2' },
        { label: '3v3 (6 players)', value: '3' },
        { label: '4v4 (8 players)', value: '4', default: true },
        { label: '5v5 (10 players)', value: '5' },
      ])
  );

  // Row 4: Save button
  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('setup_save')
      .setLabel('Save Configuration')
      .setStyle(ButtonStyle.Success)
      .setEmoji('💾'),
    new ButtonBuilder()
      .setCustomId('setup_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({
    embeds: [buildSetupEmbed(state)],
    components: [channelRow, gameRow, sizeRow, buttonRow],
  });
}

export async function handleSetupChannelSelect(interaction: ChannelSelectMenuInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  if (!pending.has(key)) return;

  const channel = interaction.channels.first();
  const state = pending.get(key)!;
  state.channelId   = channel?.id ?? null;
  state.channelName = channel && 'name' in channel ? (channel.name ?? null) : null;

  await interaction.editReply({ embeds: [buildSetupEmbed(state)] });
}

export async function handleSetupGameSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  if (!pending.has(key)) return;

  const gameId = interaction.values[0];
  const { data: game } = await supabase.from('games').select('name').eq('id', gameId).single();

  const state = pending.get(key)!;
  state.gameId   = gameId;
  state.gameName = game?.name ?? gameId;

  await interaction.editReply({ embeds: [buildSetupEmbed(state)] });
}

export async function handleSetupSizeSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  if (!pending.has(key)) return;

  const state = pending.get(key)!;
  state.teamSize = parseInt(interaction.values[0]);

  await interaction.editReply({ embeds: [buildSetupEmbed(state)] });
}

export async function handleSetupSave(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  const state = pending.get(key);

  if (!state) {
    return interaction.followUp({ content: '❌ Setup session expired. Run `/8s-setup` again.', ephemeral: true });
  }

  if (!state.channelId) {
    return interaction.followUp({ content: '⚠️ Please select a channel first.', ephemeral: true });
  }
  if (!state.gameId) {
    return interaction.followUp({ content: '⚠️ Please select a game first.', ephemeral: true });
  }

  const { error } = await supabase.from('eights_channel_config').upsert({
    guild_id:   interaction.guildId!,
    channel_id: state.channelId,
    game_id:    state.gameId,
    team_size:  state.teamSize,
  }, { onConflict: 'guild_id,channel_id' });

  pending.delete(key);

  if (error) {
    return interaction.followUp({ content: `❌ Failed to save: ${error.message}`, ephemeral: true });
  }

  const successEmbed = new EmbedBuilder()
    .setTitle('✅ 8sBot Channel Configured!')
    .setColor(0x10B981)
    .addFields(
      { name: '📺 Channel',   value: `<#${state.channelId}>`,            inline: true },
      { name: '🎮 Game',      value: state.gameName    || '—',           inline: true },
      { name: '👥 Team Size', value: `${state.teamSize}v${state.teamSize}`, inline: true },
    )
    .setDescription(`Players can now use \`/join\` in <#${state.channelId}> to queue up!`);

  await interaction.editReply({ embeds: [successEmbed], components: [] });
}

export async function handleSetupCancel(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  pending.delete(key);
  await interaction.editReply({
    embeds: [new EmbedBuilder().setTitle('❌ Setup cancelled').setColor(0xEF4444)],
    components: [],
  });
}
