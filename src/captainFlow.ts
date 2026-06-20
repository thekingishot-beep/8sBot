import {
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  EmbedBuilder,
  Guild,
} from 'discord.js';
import { supabase } from './supabase';
import { getMmrMap, MMR_START, snakeTeam } from './mmr';
import { getMapPool, pickRandomMaps } from './mapPool';

const AUTO_PICK_SECONDS = 60;

interface CaptainDraftState {
  queueId:        string;
  guildId:        string;
  gameId:         string | null;
  captain1Id:     string;
  captain2Id:     string;
  captain1Name:   string;
  captain2Name:   string;
  nameMap:        Map<string, string>;
  team1:          Array<{ discord_id: string; profile_id: string | null }>;
  team2:          Array<{ discord_id: string; profile_id: string | null }>;
  remaining:      Array<{ discord_id: string; profile_id: string | null }>;
  pickOrder:      Array<1 | 2>;
  currentPick:    number;
  mmrEnabled:     boolean;
  mmrMap:         Record<string, number>;
  channel:        any;
  voteMsg:        Message;
  pickStartTime:  number;
  autoPickTimer?: ReturnType<typeof setTimeout>;
  countdownTimer?: ReturnType<typeof setInterval>;
}

const drafts = new Map<string, CaptainDraftState>();

export function getDraft(queueId: string): CaptainDraftState | undefined {
  return drafts.get(queueId);
}

async function fetchDisplayNames(guild: Guild, discordIds: string[]): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  await Promise.all(
    discordIds.map(async id => {
      try {
        const member = await guild.members.fetch(id);
        nameMap.set(id, member.displayName);
      } catch {
        nameMap.set(id, `User${id.slice(-4)}`);
      }
    })
  );
  return nameMap;
}

export async function startCaptainDraft(
  queue: any,
  players: Array<{ discord_id: string; profile_id: string | null }>,
  mmrEnabled: boolean,
  channel: any,
  voteMsg: Message
) {
  const mmrMap = await getMmrMap(players.map(p => p.discord_id), queue.guild_id);
  const guild = voteMsg.guild;

  let sorted = [...players];
  if (mmrEnabled) {
    sorted.sort((a, b) => (mmrMap[b.discord_id] ?? MMR_START) - (mmrMap[a.discord_id] ?? MMR_START));
  }
  const [cap1, cap2, ...rest] = sorted;
  const remainingCount = rest.length;

  const pickOrder: Array<1 | 2> = Array.from({ length: remainingCount }, (_, i) => snakeTeam(i));

  const allIds = players.map(p => p.discord_id);
  const nameMap = guild
    ? await fetchDisplayNames(guild, allIds)
    : new Map(allIds.map(id => [id, `<@${id}>`]));

  const captain1Name = nameMap.get(cap1.discord_id) || `User${cap1.discord_id.slice(-4)}`;
  const captain2Name = nameMap.get(cap2.discord_id) || `User${cap2.discord_id.slice(-4)}`;

  const state: CaptainDraftState = {
    queueId:      queue.id,
    guildId:      queue.guild_id,
    gameId:       queue.game_id,
    captain1Id:   cap1.discord_id,
    captain2Id:   cap2.discord_id,
    captain1Name,
    captain2Name,
    nameMap,
    team1:        [cap1],
    team2:        [cap2],
    remaining:    rest,
    pickOrder,
    currentPick:  0,
    mmrEnabled,
    mmrMap,
    channel,
    voteMsg,
    pickStartTime: Date.now(),
  };
  drafts.set(queue.id, state);

  await renderDraftEmbed(state, AUTO_PICK_SECONDS);
  scheduleAutoPick(state);
}

export async function handleCaptainPickButton(
  interaction: ButtonInteraction,
  queueId: string,
  pickedDiscordId: string
) {
  await interaction.deferUpdate();

  const state = drafts.get(queueId);
  if (!state) return;

  const whoShouldPick = state.pickOrder[state.currentPick] === 1 ? state.captain1Id : state.captain2Id;
  if (interaction.user.id !== whoShouldPick) {
    await interaction.followUp({ content: `❌ It's not your turn to pick.`, ephemeral: true });
    return;
  }

  makePick(state, pickedDiscordId);
}

function makePick(state: CaptainDraftState, discordId: string) {
  if (state.autoPickTimer)  { clearTimeout(state.autoPickTimer);   delete state.autoPickTimer; }
  if (state.countdownTimer) { clearInterval(state.countdownTimer); delete state.countdownTimer; }

  const pickedIdx = state.remaining.findIndex(p => p.discord_id === discordId);
  if (pickedIdx === -1) return;

  const [picked] = state.remaining.splice(pickedIdx, 1);
  const pickTeam = state.pickOrder[state.currentPick];
  (pickTeam === 1 ? state.team1 : state.team2).push(picked);
  state.currentPick++;

  if (state.remaining.length === 0) {
    finalizeDraft(state);
  } else {
    state.pickStartTime = Date.now();
    renderDraftEmbed(state, AUTO_PICK_SECONDS);
    scheduleAutoPick(state);
  }
}

function scheduleAutoPick(state: CaptainDraftState) {
  // Live countdown: re-render every 10s so the embed shows remaining seconds
  state.countdownTimer = setInterval(() => {
    const elapsed    = Math.floor((Date.now() - state.pickStartTime) / 1000);
    const remaining  = Math.max(0, AUTO_PICK_SECONDS - elapsed);
    renderDraftEmbed(state, remaining).catch(() => {});
  }, 10_000);

  state.autoPickTimer = setTimeout(() => {
    if (state.countdownTimer) { clearInterval(state.countdownTimer); delete state.countdownTimer; }
    if (state.remaining.length === 0) return;
    const sorted = [...state.remaining].sort(
      (a, b) => (state.mmrMap[b.discord_id] ?? MMR_START) - (state.mmrMap[a.discord_id] ?? MMR_START)
    );
    makePick(state, sorted[0].discord_id);
  }, AUTO_PICK_SECONDS * 1000);
}

async function renderDraftEmbed(state: CaptainDraftState, remainingSeconds?: number) {
  const currentPickTeam  = state.pickOrder[state.currentPick];
  const currentCaptainId = currentPickTeam === 1 ? state.captain1Id : state.captain2Id;

  const formatTeam = (members: typeof state.team1) =>
    members.map((p, i) => {
      const name = state.nameMap.get(p.discord_id) || `<@${p.discord_id}>`;
      const mmr  = state.mmrEnabled ? ` (${state.mmrMap[p.discord_id] ?? MMR_START})` : '';
      return i === 0 ? `👑 **${name}**${mmr}` : `${name}${mmr}`;
    }).join('\n') || '—';

  const numberedPool = state.remaining
    .map((p, i) => {
      const name = state.nameMap.get(p.discord_id) || `<@${p.discord_id}>`;
      const mmr  = state.mmrEnabled ? ` (${state.mmrMap[p.discord_id] ?? MMR_START})` : '';
      return `**${i + 1}.** ${name}${mmr}`;
    })
    .join('\n');

  const countdownStr = remainingSeconds !== undefined ? `Auto picks in **${remainingSeconds}s**` : '';

  const embed = new EmbedBuilder()
    .setTitle('👑 Captain Draft — Snake Pick')
    .setColor(0xF59E0B)
    .setDescription(
      `Currently Picking: <@${currentCaptainId}>\nSnake Draft · ${countdownStr}`
    )
    .addFields(
      { name: `🔵 ${state.captain1Name}'s Team`, value: formatTeam(state.team1), inline: true },
      { name: `🔴 ${state.captain2Name}'s Team`, value: formatTeam(state.team2), inline: true },
      { name: '📋 Available Players',             value: numberedPool || '—',    inline: false },
    );

  // Build pick buttons — max 5 per row, up to 5 rows
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const chunks = chunkArray(state.remaining, 5);
  for (const chunk of chunks.slice(0, 5)) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const p of chunk) {
      const name  = state.nameMap.get(p.discord_id) || `User${p.discord_id.slice(-4)}`;
      const mmr   = state.mmrEnabled ? ` (${state.mmrMap[p.discord_id] ?? MMR_START})` : '';
      const label = `${name}${mmr}`.slice(0, 80);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`captain_pick_${state.queueId}_${p.discord_id}`)
          .setLabel(label)
          .setStyle(ButtonStyle.Secondary)
      );
    }
    rows.push(row);
  }

  await state.voteMsg.edit({ embeds: [embed], components: rows });
}

async function finalizeDraft(state: CaptainDraftState) {
  drafts.delete(state.queueId);

  const pool   = await getMapPool(state.gameId);
  const maps   = pickRandomMaps(pool, 1);
  const chosen = maps[0];

  const mapName  = chosen?.name     || 'TBD';
  const modeName = chosen?.modeName || 'TBD';

  const { startMatchFromTeams } = await import('./queueFlow');
  await startMatchFromTeams(
    state.queueId,
    state.team1,
    state.team2,
    mapName,
    modeName,
    'captains',
    state.voteMsg,
    state.captain1Name,
    state.captain2Name
  );
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
