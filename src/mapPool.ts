import { supabase } from './supabase';

export interface MapEntry { id: string; name: string; image?: string; }
export interface GameModeEntry { key: string; name: string; }

export interface MapPool {
  maps: Record<string, MapEntry[]>;
  gameModes: GameModeEntry[];
}

// Reads the map pool from site_settings — same data source as /admin-match-settings
export async function getMapPool(gameId: string | null): Promise<MapPool> {
  const key = gameId ? `match_settings_${gameId}` : 'match_settings';
  const { data } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', key)
    .single();

  if (!data?.value) return { maps: {}, gameModes: [] };

  try {
    const parsed = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
    return {
      maps: parsed.maps || {},
      gameModes: parsed.gameModes || [],
    };
  } catch {
    return { maps: {}, gameModes: [] };
  }
}

// Pick N random maps across all modes for a vote
export function pickRandomMaps(pool: MapPool, count = 4): Array<MapEntry & { mode: string; modeName: string }> {
  const all: Array<MapEntry & { mode: string; modeName: string }> = [];
  for (const [modeKey, maps] of Object.entries(pool.maps)) {
    const modeName = pool.gameModes.find(m => m.key === modeKey)?.name || modeKey;
    for (const map of maps) {
      all.push({ ...map, mode: modeKey, modeName });
    }
  }
  // Fisher-Yates shuffle then slice
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, count);
}
