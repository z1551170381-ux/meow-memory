// functions/api/memory-batch.js
// POST /api/memory-batch
// body: { user_id?, persona_id?, persona_name?, scope_id?, dedupe?, items: [...] }
// 作用：把记忆家整理出的摘句 / 锚点 / 天气胶囊 / flashback token 批量写入 iw_memories

import {
  embed,
  sbInsertMemory,
  sbFindMemoryBySource,
  sbUpdateMemory,
  jsonResp,
  corsPreflight,
} from './_lib.js';

export async function onRequestOptions() {
  return corsPreflight();
}

function cleanText(v, max = 5000) {
  return String(v || '').trim().slice(0, max);
}

function buildMetadata(item, body) {
  const itemType = cleanText(item.item_type || item.type || 'note', 80);
  const source = cleanText(item.source || item.metadata?.source || 'memory_home', 120);
  const sourceId = cleanText(item.source_id || item.metadata?.source_id || item.id || '', 240);

  return {
    ...(item.metadata || {}),

    user_id: cleanText(item.user_id || body.user_id || item.metadata?.user_id || 'default', 120),
    source,
    source_id: sourceId,

    persona_id: cleanText(item.persona_id || body.persona_id || item.metadata?.persona_id || '', 120),
    persona_name: cleanText(item.persona_name || body.persona_name || item.metadata?.persona_name || '', 120),
    scope_id: cleanText(item.scope_id || body.scope_id || item.metadata?.scope_id || '', 160),

    item_type: itemType,
    source_url: cleanText(item.source_url || item.metadata?.source_url || '', 1000),
    token: cleanText(item.token || item.metadata?.token || '', 500),

    tags: Array.isArray(item.tags)
      ? item.tags.map(x => cleanText(x, 80)).filter(Boolean).slice(0, 20)
      : Array.isArray(item.metadata?.tags)
        ? item.metadata.tags
        : [],

    weight: Number.isFinite(Number(item.weight ?? item.metadata?.weight))
      ? Number(item.weight ?? item.metadata?.weight)
      : 1,

    happened_at: item.happened_at || item.metadata?.happened_at || null,
    synced_from: 'memory_home',
    synced_at: new Date().toISOString(),
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const items = Array.isArray(body.items) ? body.items : [];
    const dedupe = body.dedupe !== false;

    if (!items.length) {
      return jsonResp({ error: 'items 不能为空' }, 400);
    }

    if (items.length > 50) {
      return jsonResp({ error: '一次最多同步 50 条，先小批量跑稳' }, 400);
    }

    const saved = [];
    const failed = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      try {
        const content = cleanText(item.content || item.summary || item.quote || item.text);
        if (!content) {
          failed.push({ index: i, error: 'content 不能为空' });
          continue;
        }

        const itemType = cleanText(item.item_type || item.type || 'note', 80);
        const metadata = buildMetadata(item, body);
        const vector = await embed(content, env);

        let row = null;
        let action = 'inserted';

        if (dedupe && metadata.source && metadata.source_id) {
          const existing = await sbFindMemoryBySource(env, metadata.source, metadata.source_id);
          if (existing?.id != null) {
            row = await sbUpdateMemory(env, existing.id, {
              content,
              type: itemType,
              metadata,
              embedding: vector,
            });
            action = 'updated';
          }
        }

        if (!row) {
          row = await sbInsertMemory(env, {
            content,
            type: itemType,
            metadata,
            embedding: vector,
          });
        }

        saved.push({
          index: i,
          id: row.id,
          action,
          type: itemType,
          source: metadata.source,
          source_id: metadata.source_id,
        });
      } catch (e) {
        failed.push({
          index: i,
          error: String(e.message || e),
        });
      }
    }

    return jsonResp({
      ok: true,
      saved_count: saved.length,
      failed_count: failed.length,
      saved,
      failed,
    });
  } catch (err) {
    console.error('[memory-batch] error:', err);
    return jsonResp({ error: String(err.message || err) }, 500);
  }
}
