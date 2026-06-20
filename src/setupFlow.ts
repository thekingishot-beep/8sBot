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
  TextChannel,
} from 'discord.js';
import { supabase } from './supabase';
import { buildQueueEmbed } from './queueEmbed';

// Pending config state per user (in-memory, fine for persistent Railway process)
const pending = new Map<string, {
  channelId:          string | null;
  channelName:        string | null;
  gameId:             string | null;
  gameName:           string | null;
  teamSize:           number;
  resultsChannelId:   string | null;
  resultsChannelName: string | null;
}>();

function pendingKey(guildId: string, userId: string) {
  return `${guildId}-${userId}`;
}

function buildSetupEmbed(state: {
  channelName:        string | null;
  gameName:           string | null;
  teamSize:           number;
  resultsChannelName: string | null;
}) {
  return new EmbedBuilder()
    .setTitle('⚙️ 8sBot Channel Setup')
    .setColor(0x3B82F6)
    .setDescription('Configure a channel for the 8s queue. Select all options then click **Save**.')
    .addFields(
      { name: '📺 Queue Channel',    value: state.channelName        ? `#${state.channelName}`        : '*Not selected*', inline: true },
      { name: '🎮 Game',             value: state.gameName           || '*Not selected*',             inline: true },
      { name: '👥 Team Size',        value: `${state.teamSize}v${state.teamSize}`,                    inline: true },
      { name: '📣 Results Channel',  value: state.resultsChannelName ? `#${state.resultsChannelName}` : '*Same as queue channel*', inline: true },
    );
}

export async function handleSetupCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const userId  = interaction.user.id;
  const guildId = interaction.guildId!;

  const { data: games } = await supabase.from('games').select('id, name').order('name');
  if (!games || games.length === 0) {
    return interaction.editReply({ content: '❌ No games found in ScrimCenter. Add games first at /admin.' });
  }

  const key = pendingKey(guildId, userId);
  pending.set(key, { channelId: null, channelName: null, gameId: null, gameName: null, teamSize: 4, resultsChannelId: null, resultsChannelName: null });
  const state = pending.get(key)!;

  // Row 1: Queue channel
  const channelRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('setup_channel')
      .setPlaceholder('Select the queue channel')
      .addChannelTypes(ChannelType.GuildText)
  );

  // Row 2: Game
  const gameRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('setup_game')
      .setPlaceholder('Select a game')
      .addOptions(games.map((g: any) => ({ label: g.name, value: g.id })))
  );

  // Row 3: Team size
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

  // Row 4: Results channel (optional — winner cards post here)
  const resultsRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('setup_results_channel')
      .setPlaceholder('Results channel (optional — defaults to queue channel)')
      .addChannelTypes(ChannelType.GuildText)
  );

  // Row 5: Actions
  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('setup_save').setLabel('Save').setStyle(ButtonStyle.Success).setEmoji('💾'),
    new ButtonBuilder().setCustomId('setup_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({
    embeds: [buildSetupEmbed(state)],
    components: [channelRow, gameRow, sizeRow, resultsRow, buttonRow],
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

export async function handleSetupResultsChannelSelect(interaction: ChannelSelectMenuInteraction) {
  await interaction.deferUpdate();
  const key = pendingKey(interaction.guildId!, interaction.user.id);
  if (!pending.has(key)) return;

  const channel = interaction.channels.first();
  const state = pending.get(key)!;
  state.resultsChannelId   = channel?.id ?? null;
  state.resultsChannelName = channel && 'name' in channel ? (channel.name ?? null) : null;

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
  const key   = pendingKey(interaction.guildId!, interaction.user.id);
  const state = pending.get(key);

  if (!state) {
    return interaction.followUp({ content: '❌ Setup session expired. Run `/8s-setup` again.', ephemeral: true });
  }
  if (!state.channelId) {
    return interaction.followUp({ content: '⚠️ Please select a queue channel first.', ephemeral: true });
  }
  if (!state.gameId) {
    return interaction.followUp({ content: '⚠️ Please select a game first.', ephemeral: true });
  }

  const { error } = await supabase.from('eights_channel_config').upsert({
    guild_id:           interaction.guildId!,
    channel_id:         state.channelId,
    game_id:            state.gameId,
    team_size:          state.teamSize,
    results_channel_id: state.resultsChannelId,
  }, { onConflict: 'guild_id,channel_id' });

  pending.delete(key);

  if (error) {
    return interaction.followUp({ content: `❌ Failed to save: ${error.message}`, ephemeral: true });
  }

  const successEmbed = new EmbedBuilder()
    .setTitle('✅ 8sBot Channel Configured!')
    .setColor(0x10B981)
    .addFields(
      { name: '📺 Queue Channel',   value: `<#${state.channelId}>`,                          inline: true },
      { name: '🎮 Game',            value: state.gameName    || '—',                         inline: true },
      { name: '👥 Team Size',       value: `${state.teamSize}v${state.teamSize}`,            inline: true },
      { name: '📣 Results Channel', value: state.resultsChannelId ? `<#${state.resultsChannelId}>` : 'Same as queue channel', inline: true },
    )
    .setDescription(`Queue embed posted in <#${state.channelId}>. Players can now click **Join Queue** to enter!`);

  await interaction.editReply({ embeds: [successEmbed], components: [] });

  // Auto-post the queue embed to the configured channel
  try {
    const queueChannel = await interaction.client.channels.fetch(state.channelId) as TextChannel;
    if (queueChannel && 'send' in queueChannel) {
      const { embed, row } = buildQueueEmbed([], state.teamSize, state.gameName || 'Queue', true);
      const msg = await queueChannel.send({ embeds: [embed], components: [row] });

      // Create a fresh waiting queue row so join/leave buttons work immediately
      const { data: existing } = await supabase
        .from('eights_queues')
        .select('id')
        .eq('guild_id', interaction.guildId!)
        .eq('channel_id', state.channelId)
        .eq('status', 'waiting')
        .single();

      if (!existing) {
        await supabase.from('eights_queues').insert({
          guild_id:   interaction.guildId!,
          channel_id: state.channelId,
          game_id:    state.gameId,
          team_size:  state.teamSize,
          status:     'waiting',
          message_id: msg.id,
        });
      } else {
        await supabase.from('eights_queues').update({ message_id: msg.id }).eq('id', existing.id);
      }
    }
  } catch (err) {
    console.error('Failed to auto-post queue embed:', err);
  }
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
