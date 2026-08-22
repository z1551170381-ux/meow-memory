-- Register the local Codex persona in the cloud memory registry.
-- The local Mac remains the primary body; VPS presence is a memory doorway
-- and a future World Workshop room.
insert into public.iw_personas (id, display_name, enabled, metadata)
values (
  'codex_xiaoke',
  '管家小可',
  true,
  '{
    "home": "local_mac",
    "kind": "local_codex",
    "vps_presence": "memory_door_and_future_room",
    "body_note": "本体在本地 Mac，VPS 仅保存独立记忆门牌与未来世界工坊房间"
  }'::jsonb
)
on conflict (id) do update
set display_name = excluded.display_name,
    enabled = true,
    metadata = coalesce(public.iw_personas.metadata, '{}'::jsonb) || excluded.metadata,
    updated_at = now();
