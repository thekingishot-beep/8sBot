import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { MmrDelta, MMR_START } from './mmr';

const SITE_URL = process.env.SITE_URL || 'https://scrimcenter.com';

// ─── Queue embed (persistent — updated in place as players join/leave) ────────

export function buildQueueEmbed(
  playerList: Array<{ tag: string; mmr?: number }>,
  teamSize: number,
  gameName: string,
  mmrEnabled: boolean
) {
  const total  = teamSize * 2;
  const filled = playerList.length;

  const playerLines = playerList.length > 0
    ? playerList.map(p => mmrEnabled && p.mmr !== undefined ? `${p.tag} (${p.mmr})` : p.tag).join('\n')
    : '*Waiting for players...*';

  const embed = new EmbedBuilder()
    .setTitle(`${gameName} ${teamSize}v${teamSize} Queue`)
    .setColor(0x3B82F6)
    .setDescription(playerLines)
    .addFields({ name: '​', value: `**Queue ${filled}/${total}**` })
    .setTimestamp();

  const joinRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('queue_join')
      .setLabel('Join Queue')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('queue_leave')
      .setLabel('Leave Queue')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setLabel('Web Queue')
      .setStyle(ButtonStyle.Link)
      .setURL(`${SITE_URL}/8s`),
    new ButtonBuilder()
      .setCustomId('queue_force_start')
      .setLabel('Force Start')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('queue_cancel')
      .setLabel('Cancel Queue')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, row: joinRow };
}

// ─── Team vote embed ───────────────────────────────────────────────────────────

export function buildTeamVoteEmbed(
  queueId: string,
  votes: Record<string, string[]> = {},
  mmrVotes: Record<string, string[]> = {}
) {
  const vCount = (key: string) => (votes[key] || []).length;
  const mCount = (key: string) => (mmrVotes[key] || []).length;

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Team Selection')
    .setColor(0xF59E0B)
    .setDescription('Queue is full! Vote for how teams are picked. **30 seconds** — majority wins.')
    .addFields(
      { name: 'Balanced',  value: `Votes: ${vCount('balanced')}`,  inline: true },
      { name: 'Captains',  value: `Votes: ${vCount('captains')}`,  inline: true },
      { name: 'Random',    value: `Votes: ${vCount('random')}`,    inline: true },
      { name: 'Unfair',    value: `Votes: ${vCount('unfair')}`,    inline: true },
      { name: '​',    value: `Enable MMR (${mCount('enable')}) — Disable MMR (${mCount('disable')})` },
    );

  const voteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`teamvote_balanced_${queueId}`).setLabel('Balanced').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`teamvote_captains_${queueId}`).setLabel('Captains').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`teamvote_random_${queueId}`).setLabel('Random').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`teamvote_unfair_${queueId}`).setLabel('Unfair').setStyle(ButtonStyle.Primary),
  );

  const mmrRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`mmrvote_enable_${queueId}`).setLabel('Enable MMR').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`mmrvote_disable_${queueId}`).setLabel('Disable MMR').setStyle(ButtonStyle.Danger),
  );

  return { embed, rows: [voteRow, mmrRow] };
}

// ─── Map vote embed ────────────────────────────────────────────────────────────

export function buildMapVoteEmbed(options: Array<{ id: string; name: string; modeName: string }>) {
  const embed = new EmbedBuilder()
    .setTitle('🗺️ Vote for Map')
    .setColor(0x8B5CF6)
    .setDescription('Vote for the map to play. Voting closes in **60 seconds** — most votes wins.');

  options.forEach((opt, i) => {
    embed.addFields({ name: `Option ${i + 1}`, value: `**${opt.name}** · *${opt.modeName}*`, inline: true });
  });

  const row = new ActionRowBuilder<ButtonBuilder>();
  options.forEach(opt => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`mapvote_${opt.id}`)
        .setLabel(`${opt.name} (${opt.modeName})`)
        .setStyle(ButtonStyle.Secondary)
    );
  });

  return { embed, row };
}

// ─── Match card embed ──────────────────────────────────────────────────────────

export function buildMatchEmbed(
  team1: string[],
  team2: string[],
  map: string,
  mode: string,
  teamSelection: string,
  matchNumber?: number,
  captain1Name?: string,
  captain2Name?: string
) {
  const title = matchNumber ? `⚔️ Match #${matchNumber}` : '⚔️ Match Ready';
  const t1Label = captain1Name ? `🔵 ${captain1Name}'s Team Won` : '🔵 Team 1 Won';
  const t2Label = captain2Name ? `🔴 ${captain2Name}'s Team Won` : '🔴 Team 2 Won';

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x10B981)
    .setDescription('GL HF! Report the result when done.')
    .addFields(
      { name: captain1Name ? `🔵 ${captain1Name}'s Team` : '🔵 Team 1', value: team1.join('\n') || '—', inline: true },
      { name: captain2Name ? `🔴 ${captain2Name}'s Team` : '🔴 Team 2', value: team2.join('\n') || '—', inline: true },
      { name: '​',    value: '​',                 inline: true },
      { name: '🗺️ Map',    value: map,                      inline: true },
      { name: '🎯 Mode',   value: mode,                     inline: true },
      { name: '⚙️ Teams',  value: teamSelection,             inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('result_1').setLabel(t1Label.slice(0, 80)).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('result_2').setLabel(t2Label.slice(0, 80)).setStyle(ButtonStyle.Danger),
  );

  return { embed, row };
}

// ─── Winner card embed ─────────────────────────────────────────────────────────

export function buildWinnerEmbed(
  team1Tags: string[],
  team2Tags: string[],
  winnerTeam: 1 | 2,
  deltas: MmrDelta[],
  map: string,
  mode: string,
  matchNumber?: number,
  mmrEnabled?: boolean
) {
  const queueLabel = matchNumber ? `Queue#${matchNumber}` : 'Queue';

  const mmrForTeam = (tags: string[], team: 1 | 2, allDeltas: MmrDelta[]) => {
    const discordIdFromTag = (tag: string) => tag.replace(/[<@>]/g, '');
    const teamDeltas = allDeltas.filter(d => {
      const id = discordIdFromTag(tags.find(t => t.includes(d.discordId)) || '');
      return !!id;
    });
    const sign = team === winnerTeam ? '+' : '-';
    const change = team === winnerTeam ? 25 : 25;
    return mmrEnabled ? `${sign}${change} MMR` : null;
  };

  const winTeamLabel = winnerTeam === 1 ? '🔵 Team 1' : '🔴 Team 2';
  const loseTeamLabel = winnerTeam === 1 ? '🔴 Team 2' : '🔵 Team 1';
  const winTeamTags = winnerTeam === 1 ? team1Tags : team2Tags;
  const loseTeamTags = winnerTeam === 1 ? team2Tags : team1Tags;

  const buildTeamField = (tags: string[], isWinner: boolean) => {
    if (!mmrEnabled) return tags.join('\n') || '—';
    const delta = isWinner ? `+${25}` : `-${25}`;
    return tags.join('\n') + `\n**${delta} MMR**`;
  };

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Winner For ${queueLabel}`)
    .setColor(0xF59E0B)
    .addFields(
      { name: `${winTeamLabel} WIN`,  value: buildTeamField(winTeamTags, true),   inline: true },
      { name: `${loseTeamLabel} LOSS`, value: buildTeamField(loseTeamTags, false), inline: true },
    );

  if (map && map !== 'TBD') {
    embed.setFooter({ text: `Map: ${map}  |  Mode: ${mode}` });
  }

  return embed;
}

// ─── Stats card embed (NeatQueue style) ───────────────────────────────────────

export function buildStatsEmbed(
  displayName: string,
  avatarURL: string | null,
  mmr: number,
  rank: number,
  wins: number,
  losses: number,
  recentGames: Array<{ won: boolean; delta: number; createdAt: string }>,
  mmrEnabled: boolean,
  gameName?: string
) {
  const games  = wins + losses;
  const winRate = games > 0 ? Math.round((wins / games) * 100) : 0;
  const title   = gameName ? `${displayName}'s ${gameName} Stats` : `${displayName}'s Stats`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x3B82F6)
    .addFields(
      { name: 'PLAYER',   value: displayName,               inline: true },
      { name: 'MMR',      value: mmrEnabled ? String(mmr) : 'N/A', inline: true },
      { name: '​',   value: '​',                  inline: true },
      { name: 'RANK',     value: rank > 0 ? `#${rank}` : 'Unranked', inline: true },
      { name: 'WINRATE',  value: `${winRate}%`,             inline: true },
      { name: 'PREVIOUS GAMES', value: formatRecentGames(recentGames, mmrEnabled), inline: true },
      { name: 'WINS',     value: String(wins),              inline: true },
      { name: 'LOSSES',   value: String(losses),            inline: true },
      { name: 'GAMES',    value: String(games),             inline: true },
    );

  if (avatarURL) embed.setThumbnail(avatarURL);

  return embed;
}

function formatRecentGames(
  games: Array<{ won: boolean; delta: number; createdAt: string }>,
  mmrEnabled: boolean
): string {
  if (games.length === 0) return '*No recent games*';
  return games.slice(0, 6).map(g => {
    const icon  = g.won ? '🟢' : '🔴';
    const label = g.won ? 'Win' : 'Lost';
    const delta = mmrEnabled ? ` ${g.delta > 0 ? '+' : ''}${g.delta}` : '';
    return `${icon} ${label}${delta}`;
  }).join('\n');
}

// ─── Leaderboard embed (paginated) ────────────────────────────────────────────

export type LbType = 'mmr' | 'winrate' | 'wins' | 'games';

export function buildLeaderboardEmbed(
  entries: Array<{
    discordId: string;
    displayName: string;
    mmr: number;
    wins: number;
    losses: number;
  }>,
  page: number,
  totalPages: number,
  type: LbType,
  gameName?: string,
  mmrEnabled?: boolean
) {
  const PAGE_SIZE = 10;
  const start = (page - 1) * PAGE_SIZE;
  const title = gameName ? `${gameName} MMR Leaderboard` : '8sBot MMR Leaderboard';

  const lines = entries.map((e, i) => {
    const rank    = start + i + 1;
    const trophy  = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `**${rank}.**`;
    const record  = `(${e.wins}-${e.losses})`;
    const mmrPart = mmrEnabled !== false ? ` (${e.mmr})` : '';
    return `${trophy} ${e.displayName}${mmrPart} ${record}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0xF59E0B)
    .setDescription(lines.length > 0 ? `**Page ${page}**\n${lines.join('\n')}` : '*No players yet*')
    .setFooter({ text: `/stats to see your full stats!` })
    .setTimestamp();

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lb_first_${page}_${type}`).setLabel('<<').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`lb_prev_${page}_${type}`).setLabel('<').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`lb_page_${page}_${type}`).setLabel(`${page}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`lb_next_${page}_${type}`).setLabel('>').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
    new ButtonBuilder().setCustomId(`lb_last_${page}_${type}`).setLabel('>>').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
  );

  const typeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`lb_type_${page}`)
      .setPlaceholder('Leaderboard Type')
      .addOptions([
        { label: 'MMR',      value: 'mmr',     default: type === 'mmr'     },
        { label: 'Win Rate', value: 'winrate', default: type === 'winrate' },
        { label: 'Most Wins', value: 'wins',   default: type === 'wins'    },
        { label: 'Most Games', value: 'games', default: type === 'games'   },
      ])
  );

  return { embed, rows: [navRow, typeRow] };
}
