import { supabase } from './supabase';

export const MMR_WIN   = 25;
export const MMR_LOSS  = 25;
export const MMR_START = 1000;
export const MMR_MIN   = 100;

export interface MmrDelta {
  discordId:  string;
  mmrBefore:  number;
  mmrAfter:   number;
  delta:      number;
  won:        boolean;
}

// Get a player's current MMR (returns 1000 if they have no row yet — don't create one yet)
export async function getPlayerMmr(discordId: string, guildId: string): Promise<number> {
  const { data } = await supabase
    .from('eights_player_mmr')
    .select('mmr')
    .eq('discord_id', discordId)
    .eq('guild_id', guildId)
    .single();
  return data?.mmr ?? MMR_START;
}

// Bulk fetch MMR for a list of players — missing players default to MMR_START
export async function getMmrMap(
  discordIds: string[],
  guildId: string
): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  for (const id of discordIds) map[id] = MMR_START;

  if (discordIds.length === 0) return map;

  const { data } = await supabase
    .from('eights_player_mmr')
    .select('discord_id, mmr')
    .in('discord_id', discordIds)
    .eq('guild_id', guildId);

  for (const row of (data || [])) map[row.discord_id] = row.mmr;
  return map;
}

// Upsert a player's MMR row (called when they join the queue so username is always fresh)
export async function touchMmrRow(discordId: string, guildId: string, username: string): Promise<number> {
  const { data } = await supabase
    .from('eights_player_mmr')
    .upsert(
      { discord_id: discordId, guild_id: guildId, discord_username: username },
      { onConflict: 'discord_id,guild_id', ignoreDuplicates: false }
    )
    .select('mmr')
    .single();
  return data?.mmr ?? MMR_START;
}

// Apply MMR changes after a match completes — inserts history rows and updates current MMR
export async function applyMmrAfterMatch(
  matchId: string,
  guildId: string,
  winnerTeam: 1 | 2
): Promise<MmrDelta[]> {
  const { data: players } = await supabase
    .from('eights_match_players')
    .select('discord_id, team')
    .eq('match_id', matchId);

  if (!players || players.length === 0) return [];

  const discordIds = players.map(p => p.discord_id);

  // Fetch MMR + current win streak in one query
  const { data: mmrRows } = await supabase
    .from('eights_player_mmr')
    .select('discord_id, mmr, win_streak')
    .in('discord_id', discordIds)
    .eq('guild_id', guildId);

  const mmrMap:    Record<string, number> = {};
  const streakMap: Record<string, number> = {};
  for (const id of discordIds) { mmrMap[id] = MMR_START; streakMap[id] = 0; }
  for (const row of (mmrRows || [])) {
    mmrMap[row.discord_id]    = row.mmr;
    streakMap[row.discord_id] = row.win_streak ?? 0;
  }

  const deltas: MmrDelta[] = [];
  const historyRows: any[] = [];
  const now = new Date().toISOString();

  for (const p of players) {
    const won       = p.team === winnerTeam;
    const before    = mmrMap[p.discord_id]    ?? MMR_START;
    const streak    = streakMap[p.discord_id] ?? 0;
    const newStreak = won ? streak + 1 : 0;

    // +5 bonus MMR per existing win streak (streak before this win), capped at +25 bonus
    const streakBonus = won ? Math.min(streak * 5, 25) : 0;
    const change  = won ? MMR_WIN + streakBonus : -MMR_LOSS;
    const after   = Math.max(MMR_MIN, before + change);
    const delta   = after - before;

    deltas.push({ discordId: p.discord_id, mmrBefore: before, mmrAfter: after, delta, won });
    historyRows.push({
      discord_id: p.discord_id,
      guild_id:   guildId,
      match_id:   matchId,
      mmr_before: before,
      mmr_after:  after,
      delta,
      won,
    });

    await supabase.from('eights_player_mmr').upsert({
      discord_id:    p.discord_id,
      guild_id:      guildId,
      mmr:           after,
      peak_mmr:      after,
      win_streak:    newStreak,
      last_match_at: now,
      updated_at:    now,
    }, { onConflict: 'discord_id,guild_id' });

    if (delta > 0) {
      try {
        await supabase.from('eights_player_mmr')
          .update({ peak_mmr: after })
          .eq('discord_id', p.discord_id)
          .eq('guild_id', guildId)
          .lt('peak_mmr', after);
      } catch { /* non-fatal */ }
    }
  }

  await supabase.from('eights_mmr_history').insert(historyRows);
  return deltas;
}

// Assign Discord rank roles based on a player's new MMR
export async function assignRankRoles(
  guild: any,
  playerDeltas: MmrDelta[],
  guildId: string
): Promise<void> {
  const { data: configs } = await supabase
    .from('eights_channel_config')
    .select('rank_roles')
    .eq('guild_id', guildId)
    .limit(1);

  const rankRoles: Array<{ minMmr: number; roleId: string; label: string }> =
    configs?.[0]?.rank_roles || [];
  if (rankRoles.length === 0) return;

  const allRoleIds = rankRoles.map(r => r.roleId);

  for (const d of playerDeltas) {
    try {
      const member = await guild.members.fetch(d.discordId);

      // Remove all rank roles the member currently holds
      for (const roleId of allRoleIds) {
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId).catch(() => {});
        }
      }

      // Assign the highest qualifying role
      const qualified = rankRoles
        .filter(r => d.mmrAfter >= r.minMmr)
        .sort((a, b) => b.minMmr - a.minMmr);
      if (qualified.length > 0) {
        await member.roles.add(qualified[0].roleId).catch(() => {});
      }
    } catch { /* member left guild or role missing */ }
  }
}

// Return 1-based rank position for a player on this guild (0 = unranked)
export async function getPlayerRank(discordId: string, guildId: string): Promise<number> {
  const { data } = await supabase
    .from('eights_player_mmr')
    .select('discord_id')
    .eq('guild_id', guildId)
    .order('mmr', { ascending: false });

  if (!data) return 0;
  const idx = data.findIndex(r => r.discord_id === discordId);
  return idx >= 0 ? idx + 1 : 0;
}

// Split players into balanced teams by MMR using snake draft order
// Returns { team1: [...], team2: [...] }
export function splitBalanced(
  players: Array<{ discord_id: string; profile_id: string | null }>,
  mmrMap: Record<string, number>
): { team1: typeof players; team2: typeof players } {
  const sorted = [...players].sort((a, b) => (mmrMap[b.discord_id] ?? MMR_START) - (mmrMap[a.discord_id] ?? MMR_START));
  const team1: typeof players = [];
  const team2: typeof players = [];
  // Snake: 1,2,2,1,1,2,2,1,...
  sorted.forEach((p, i) => {
    const pickTeam = snakeTeam(i);
    (pickTeam === 1 ? team1 : team2).push(p);
  });
  return { team1, team2 };
}

// Split players into "unfair" teams — top half by MMR vs bottom half
export function splitUnfair(
  players: Array<{ discord_id: string; profile_id: string | null }>,
  mmrMap: Record<string, number>
): { team1: typeof players; team2: typeof players } {
  const sorted = [...players].sort((a, b) => (mmrMap[b.discord_id] ?? MMR_START) - (mmrMap[a.discord_id] ?? MMR_START));
  const half = Math.floor(sorted.length / 2);
  return { team1: sorted.slice(0, half), team2: sorted.slice(half) };
}

// Snake pick order: index 0 → T1, then pairs: T2,T2,T1,T1,...
export function snakeTeam(pickIndex: number): 1 | 2 {
  if (pickIndex === 0) return 1;
  return Math.ceil(pickIndex / 2) % 2 === 1 ? 2 : 1;
}
