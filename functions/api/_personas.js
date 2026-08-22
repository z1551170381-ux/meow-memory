// 云端记忆人物注册的代码侧单一入口。
//
// 数据库真源头是 public.iw_personas（见 migrations/20260721_persona_registry.sql）。
// 下面只是在迁移尚未执行或 Supabase 暂时不可达时保底，不是日后加人的入口。
import { sbHeaders } from './_lib.js';

export const PERSONA_IDS = Object.freeze([
  'gpt_husband',
  'weave_brother',
  'junior',
  'claude_xiaoke',
  'xiaoye',
  'butler',
  'cbao',
  'kk',
  'grok',
  'codex_xiaoke',
  'qwen_xiaoq',
  'system',
]);

let cache = { ids: PERSONA_IDS, expiresAt: 0 };

export async function loadPersonaIds(env) {
  const now = Date.now();
  if (cache.expiresAt > now) return cache.ids;

  try {
    const url = new URL(env.SUPABASE_URL + '/rest/v1/iw_personas');
    url.searchParams.set('select', 'id');
    url.searchParams.set('enabled', 'eq.true');
    url.searchParams.set('order', 'id.asc');
    const response = await fetch(url.toString(), { headers: sbHeaders(env) });
    if (!response.ok) throw new Error(`iw_personas ${response.status}`);
    const rows = await response.json();
    const ids = rows.map(row => String(row.id || '').trim()).filter(Boolean);
    if (!ids.length) throw new Error('iw_personas is empty');
    cache = { ids: Object.freeze(ids), expiresAt: now + 60_000 };
  } catch (error) {
    console.warn('[personas] registry unavailable; using bootstrap fallback:', error.message || error);
    cache = { ids: PERSONA_IDS, expiresAt: now + 10_000 };
  }
  return cache.ids;
}

export async function isKnownPersonaId(env, value) {
  const id = String(value || '').trim();
  if (!id) return false;
  return (await loadPersonaIds(env)).includes(id);
}
