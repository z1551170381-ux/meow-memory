// POST /api/memory
// body: { content, type?, metadata? }
// 返回: { saved, id, related: [...3 条相关旧记忆] }

import { embed, sbInsertMemory, sbMatchMemories, jsonResp, corsPreflight } from './_lib.js';

export async function onRequestOptions() {
  return corsPreflight();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const content = (body.content || '').trim();
    const type = (body.type || 'note').trim();
    const metadata = body.metadata || {};

    if (!content) {
      return jsonResp({ error: 'content 不能为空' }, 400);
    }
    if (content.length > 5000) {
      return jsonResp({ error: 'content 过长(>5000 字)' }, 400);
    }

    // 算 embedding
    const vector = await embed(content, env);

    // 先查相关旧记忆(写入之前,避免查到自己)
    let related = [];
    try {
      related = await sbMatchMemories(env, vector, { topK: 3, threshold: 0.5 });
    } catch (e) {
      console.warn('[memory] 查相似失败(可能库还空):', e.message);
    }

    // 存新记忆
    const saved = await sbInsertMemory(env, {
      content,
      type,
      metadata,
      embedding: vector,
    });

    return jsonResp({
      saved: true,
      id: saved.id,
      created_at: saved.created_at,
      related: related.map(r => ({
        id: r.id,
        content: r.content,
        type: r.type,
        similarity: Math.round(r.similarity * 100) / 100,
        created_at: r.created_at,
      })),
    });

  } catch (err) {
    console.error('[memory] error:', err);
    return jsonResp({ error: String(err.message || err) }, 500);
  }
}
