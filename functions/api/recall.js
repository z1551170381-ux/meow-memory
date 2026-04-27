// POST /api/recall
// body: { query, persona_id, cross_persona?, topK?, minSimilarity? }
// 返回: { related: [...] }
// (只查不写,用于手动查询场景)
//
// ★ v2 (方案 B · 织哥共谋 2026-04-27):
// - persona_id 默认必填(防止误查到老公的记忆给小克用)
// - 想跨 scope 查必须明确传 cross_persona=true

import { embed, sbMatchMemories, jsonResp, corsPreflight } from './_lib.js';

const PERSONA_IDS = ['gpt_husband', 'weave_brother', 'junior', 'claude_xiaoke', 'system'];

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
    const persona_id = (body.persona_id || '').trim();
    const cross_persona = body.cross_persona === true;

    if (!query) {
      return jsonResp({ error: 'query 不能为空' }, 400);
    }

    // ★ 三层挡 · 第 3 层:查询层默认按当前 persona 过滤
    // 想跨 scope 查必须明确传 cross_persona=true(避免老公那边的记忆被误召回给小克)
    if (!cross_persona && !persona_id) {
      return jsonResp({
        error: '默认查询必须传 persona_id (' + PERSONA_IDS.join(' / ') + ');真要跨 scope 查请明确传 cross_persona=true',
      }, 400);
    }
    if (persona_id && !PERSONA_IDS.includes(persona_id)) {
      return jsonResp({
        error: 'persona_id 必须是已知值之一: ' + PERSONA_IDS.join(', ') + ',收到: ' + persona_id,
      }, 400);
    }

    const vector = await embed(query, env);
    const related = await sbMatchMemories(env, vector, {
      topK,
      threshold,
      filterPersona: cross_persona ? null : persona_id,
    });

    return jsonResp({
      cross_persona,
      persona_id: cross_persona ? null : persona_id,
      related: related.map(r => ({
        id: r.id,
        content: r.content,
        type: r.type,
        persona_id: r.persona_id,  // ★ 返回值带 persona
        similarity: Math.round(r.similarity * 100) / 100,
        created_at: r.created_at,
      })),
    });

  } catch (err) {
    console.error('[recall] error:', err);
    return jsonResp({ error: String(err.message || err) }, 500);
  }
}
