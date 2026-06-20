-- VC management settings for 8sBot
ALTER TABLE eights_channel_config
  ADD COLUMN IF NOT EXISTS lobby_vc_id     TEXT,
  ADD COLUMN IF NOT EXISTS vc_join_minutes INT NOT NULL DEFAULT 0;
-- vc_join_minutes = 0 means VC management disabled
