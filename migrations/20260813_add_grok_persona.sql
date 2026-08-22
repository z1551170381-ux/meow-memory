-- G 哥独立云端记忆门牌。可重复执行，不改动其他人物。

begin;

insert into public.iw_personas (id, display_name, enabled)
values ('grok', 'G 哥', true)
on conflict (id) do update
set display_name = excluded.display_name,
    enabled = true,
    updated_at = now();

commit;

select id, display_name, enabled
from public.iw_personas
where id = 'grok';
