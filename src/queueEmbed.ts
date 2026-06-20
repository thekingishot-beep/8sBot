import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export function buildQueueEmbed(playerTags: string[], teamSize: number, gameName?: string) {
  const total = teamSize * 2;
  const filled = playerTags.length;
  const bar = '█'.repeat(filled) + '░'.repeat(total - filled);

  const embed = new EmbedBuilder()
    .setTitle('🎮 8sBot Queue')
    .setColor(0x3B82F6)
    .setDescription(`**${gameName || 'Call of Duty'} · 4v4**`)
    .addFields(
      { name: `Players [${filled}/${total}]`, value: bar + '\n' + (playerTags.length > 0 ? playerTags.map(t => `> ${t}`).join('\n') : '*Queue is empty*') }
    )
    .setFooter({ text: 'Use /join to enter · /leave to exit' })
    .setTimestamp();

  return embed;
}

export function buildTeamVoteEmbed() {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Choose Team Selection')
    .setColor(0xF59E0B)
    .setDescription('Queue is full! Vote for how teams should be picked.\nVoting closes in **30 seconds** — majority wins.')
    .addFields(
      { name: '🎲 Random', value: 'Teams split randomly', inline: true },
      { name: '👑 Captain Pick', value: '2 captains alternate picks', inline: true },
      { name: '⚖️ Balanced', value: 'Split by win rate', inline: true },
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('teamvote_random').setLabel('🎲 Random').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('teamvote_captains').setLabel('👑 Captain Pick').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('teamvote_balanced').setLabel('⚖️ Balanced').setStyle(ButtonStyle.Success),
  );

  return { embed, row };
}

export function buildMapVoteEmbed(options: Array<{ id: string; name: string; modeName: string }>) {
  const embed = new EmbedBuilder()
    .setTitle('🗺️ Vote for Map')
    .setColor(0x8B5CF6)
    .setDescription('Vote for the map to play. Voting closes in **60 seconds** — most votes wins.');

  const row = new ActionRowBuilder<ButtonBuilder>();
  options.forEach((opt, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`mapvote_${opt.id}`)
        .setLabel(`${opt.name} (${opt.modeName})`)
        .setStyle(ButtonStyle.Secondary)
    );
    embed.addFields({ name: `Option ${i + 1}`, value: `**${opt.name}** · *${opt.modeName}*`, inline: true });
  });

  return { embed, row };
}

export function buildMatchEmbed(
  team1: string[],
  team2: string[],
  map: string,
  mode: string,
  teamSelection: string
) {
  const embed = new EmbedBuilder()
    .setTitle('⚔️ Match Ready')
    .setColor(0x10B981)
    .addFields(
      { name: '🔵 Team 1', value: team1.map(t => `> ${t}`).join('\n') || 'TBD', inline: true },
      { name: '🔴 Team 2', value: team2.map(t => `> ${t}`).join('\n') || 'TBD', inline: true },
      { name: '​', value: '​', inline: true },
      { name: '🗺️ Map', value: map, inline: true },
      { name: '🎯 Mode', value: mode, inline: true },
      { name: '⚙️ Teams', value: teamSelection, inline: true },
    )
    .setDescription('GL HF! Report the result when you\'re done.')
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('result_1').setLabel('🔵 Team 1 Won').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('result_2').setLabel('🔴 Team 2 Won').setStyle(ButtonStyle.Danger),
  );

  return { embed, row };
}
