-- 画布连线：desk_state.connections JSONB，默认空数组
ALTER TABLE desk_state
  ADD COLUMN IF NOT EXISTS connections jsonb NOT NULL DEFAULT '[]'::jsonb;
