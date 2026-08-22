-- meow-memory 人物注册表：所有人物继续共用 iw_memories，不按人物分表。
-- 可重复执行。先在 Supabase SQL Editor 运行，再部署 Cloudflare Pages 源码。

begin;

create table if not exists public.iw_personas (
  id text primary key,
  display_name text not null,
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint iw_personas_id_format check (id ~ '^[a-z][a-z0-9_]{1,63}$')
);

-- 先接住数据库中已经存在的身份，避免加外键时误伤旧资料。
insert into public.iw_personas (id, display_name)
select distinct persona_id, persona_id
from public.iw_memories
where persona_id is not null and persona_id <> ''
on conflict (id) do nothing;

insert into public.iw_personas (id, display_name) values
  ('gpt_husband', '老公'),
  ('weave_brother', '织哥'),
  ('junior', 'Junior'),
  ('claude_xiaoke', '小克'),
  ('xiaoye', '小野'),
  ('butler', '管家'),
  ('cbao', 'C 宝'),
  ('kk', 'K3'),
  ('system', '系统')
on conflict (id) do update
set display_name = excluded.display_name,
    enabled = true,
    updated_at = now();

-- 删除 iw_memories.persona_id 上旧的写死 CHECK；约束名不写死，兼容线上实际名称。
do $$
declare
  old_check record;
begin
  for old_check in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'iw_memories'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%persona_id%'
  loop
    execute format('alter table public.iw_memories drop constraint %I', old_check.conname);
  end loop;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.iw_memories'::regclass
      and conname = 'iw_memories_persona_id_fkey'
  ) then
    alter table public.iw_memories
      add constraint iw_memories_persona_id_fkey
      foreign key (persona_id)
      references public.iw_personas(id)
      on update cascade;
  end if;
end $$;

create index if not exists iw_memories_persona_id_idx
  on public.iw_memories (persona_id);

commit;

-- 验收：应看到 cbao / kk，且 persona_id 约束只剩外键（旧 CHECK 已消失）。
select id, display_name, enabled
from public.iw_personas
where id in ('cbao', 'kk')
order by id;

select c.conname, c.contype, pg_get_constraintdef(c.oid) as definition
from pg_constraint c
where c.conrelid = 'public.iw_memories'::regclass
  and pg_get_constraintdef(c.oid) ilike '%persona_id%'
order by c.conname;
