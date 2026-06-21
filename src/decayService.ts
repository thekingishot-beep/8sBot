import { supabase } from './supabase';

const DECAY_MMR      = 25;           // MMR lost per decay tick
const GRACE_DAYS     = 30;           // days of inactivity before decay begins
const DECAY_DAYS     = 7;            // days between decay ticks
const MMR_FLOOR      = 1000;         // never decay below starting MMR
const CHECK_MS       = 6 * 60 * 60 * 1000; // check every 6 hours

export function startDecayService(): void {
  setInterval(runDecay, CHECK_MS);
  console.log('[Decay] Service started — checking every 6 hours');
}

async function runDecay(): Promise<void> {
  try {
    const now       = new Date();
    const graceDate = new Date(now.getTime() - GRACE_DAYS * 86_400_000).toISOString();
    const decayDate = new Date(now.getTime() - DECAY_DAYS * 86_400_000).toISOString();

    // Players who: played at least once, haven't played in 30+ days,
    // haven't been decayed in the last 7 days, and are above the MMR floor
    const { data: players } = await supabase
      .from('eights_player_mmr')
      .select('discord_id, guild_id, mmr')
      .not('last_match_at', 'is', null)
      .lt('last_match_at', graceDate)
      .or(`last_decay_at.is.null,last_decay_at.lt.${decayDate}`)
      .gt('mmr', MMR_FLOOR);

    if (!players || players.length === 0) return;

    console.log(`[Decay] Applying -${DECAY_MMR} MMR to ${players.length} inactive player(s)`);

    for (const p of players) {
      const newMmr = Math.max(MMR_FLOOR, p.mmr - DECAY_MMR);
      await supabase.from('eights_player_mmr')
        .update({
          mmr:           newMmr,
          last_decay_at: now.toISOString(),
          updated_at:    now.toISOString(),
        })
        .eq('discord_id', p.discord_id)
        .eq('guild_id',   p.guild_id);
    }
  } catch (err) {
    console.error('[Decay] Error during decay run:', err);
  }
}
