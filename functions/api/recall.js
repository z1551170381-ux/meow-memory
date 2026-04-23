// POST /api/recall
// body: { query, topK?, minSimilarity? }
// 返回: { related: [...] }
// (只查不写,用于手动查询场景)

import { embed, sbMatchMemories, jsonResp, corsPreflight } from './_lib.js';

export async function onRequestOptions() {
  return corsPreflight();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const query = (body.query || '').trim();
    const topK = Math.min(Math.max(Number(body.topK) || 5, 1), 20);
    const threshold = Math.min(Math.max(Number(body.minSimilarity) || 0.5, 0), 1);

    if (!query) {
      return jsonResp({ error: 'query 不能为空' }, 400);
    }

    const vector = await embed(query, env);
    const related = await sbMatchMemories(env, vector, { topK, threshold });

    return jsonResp({
      related: related.map(r => ({
        id: r.id,
        content: r.content,
        type: r.type,
        similarity: Math.round(r.similarity * 100) / 100,
        created_at: r.created_at,
      })),
    });

  } catch (err) {
    console.error('[recall] error:', err);
    return jsonResp({ error: String(err.message || err) }, 500);
  }
}
