import { supabase } from './supabase';

export interface MapEntry { id: string; name: string; image?: string; }
export interface GameModeEntry { key: string; name: string; }

export interface MapPool {
  maps: Record<string, MapEntry[]>;
  gameModes: GameModeEntry[];
}

export interface Bo5Map {
  gameNumber: number;
  map:        string;
  mode:       string;
  modeName:   string;
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

// CDL BO5 mode order: HP → S&D → Overload → HP → S&D
// Each slot picks a random map from the matching mode; same mode slots (1+4, 2+5)
// will never repeat a map if the pool has enough entries.
const BO5_SLOTS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Hardpoint',        pattern: /hardpoint/i        },
  { label: 'Search & Destroy', pattern: /search/i           },
  { label: 'Overload',         pattern: /overload|control/i },
  { label: 'Hardpoint',        pattern: /hardpoint/i        },
  { label: 'Search & Destroy', pattern: /search/i           },
];

export function pickBo5Maps(pool: MapPool): Bo5Map[] {
  const findModeKey = (pattern: RegExp): string | null =>
    pool.gameModes.find(m => pattern.test(m.name))?.key ?? null;

  // Track used map IDs per mode so games 1+4 and 2+5 don't repeat the same map
  const usedByMode = new Map<string, Set<string>>();

  return BO5_SLOTS.map(({ label, pattern }, i) => {
    const modeKey = findModeKey(pattern);
    if (!modeKey) return { gameNumber: i + 1, map: 'TBD', mode: 'TBD', modeName: label };

    const modeName = pool.gameModes.find(m => m.key === modeKey)?.name || label;
    const allMaps  = pool.maps[modeKey] || [];

    if (!usedByMode.has(modeKey)) usedByMode.set(modeKey, new Set());
    const used = usedByMode.get(modeKey)!;

    const available = allMaps.filter(m => !used.has(m.id));
    const source    = available.length > 0 ? available : allMaps; // fallback if pool is small
    const picked    = source[Math.floor(Math.random() * source.length)];

    if (picked) used.add(picked.id);

    return { gameNumber: i + 1, map: picked?.name || 'TBD', mode: modeKey, modeName };
  });
}
