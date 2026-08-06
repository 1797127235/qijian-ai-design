-- 不兼容旧流水线数据：删除已废弃类型的 Artifact 及孤立布局引用。
-- 类型：space_map / design_brief / proposal_package

DELETE FROM artifact_versions
WHERE artifact_id IN (
  SELECT id FROM artifacts
  WHERE artifact_type IN ('space_map', 'design_brief', 'proposal_package')
);

DELETE FROM artifacts
WHERE artifact_type IN ('space_map', 'design_brief', 'proposal_package');

-- desk_state.objects 中指向已删 artifact 的条目在 snapshot 时会被忽略；
-- 这里顺手清空各项目桌面布局，避免脏引用（项目本身保留）。
UPDATE desk_state SET objects = '[]'::jsonb, updated_at = NOW();
