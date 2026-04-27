// POST /api/memory
// body: { content, persona_id, type?, metadata?, cross_persona? }
// 返回: { saved, id, related: [...3 条相关旧记忆] }
//
// ★ v2 (方案 B · 织哥共谋 2026-04-27):
// - persona_id 必填,且必须是已知枚举值
// - 召回默认按当前 persona 过滤;cross_persona=true 才跨 scope 查
// - 写入和召回都带 persona

import { embed, sbInsertMemory, sbMatchMemories, jsonResp, corsPreflight } from './_lib.js';

// ★ persona_id 枚举(和 schema.md / 数据库 CHECK 约束保持一致)
const PERSONA_IDS = ['gpt_husband', 'weave_brother', 'junior', 'claude_xiaoke', 'system'];

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
    const persona_id = (body.persona_id || '').trim();
    const cross_persona = body.cross_persona === true;

    if (!content) {
      return jsonResp({ error: 'content 不能为空' }, 400);
    }
    if (content.length > 5000) {
      return jsonResp({ error: 'content 过长(>5000 字)' }, 400);
    }

    // ★ 三层挡 · 第 2 层:API 上传层强制必填 + 校验枚举
    if (!persona_id) {
      return jsonResp({
        error: 'persona_id 必填。可选值: ' + PERSONA_IDS.join(', '),
      }, 400);
    }
    if (!PERSONA_IDS.includes(persona_id)) {
      return jsonResp({
        error: 'persona_id 必须是已知值之一: ' + PERSONA_IDS.join(', ') + ',收到: ' + persona_id,
      }, 400);
    }

    // 算 embedding
    const vector = await embed(content, env);

    // 先查相关旧记忆(写入之前,避免查到自己)
    // ★ 默认按当前 persona 过滤;cross_persona=true 时跨 scope 查
    let related = [];
    try {
      related = await sbMatchMemories(env, vector, {
        topK: 3,
        threshold: 0.5,
        filterPersona: cross_persona ? null : persona_id,
      });
    } catch (e) {
      console.warn('[memory] 查相似失败(可能库还空):', e.message);
    }

    // 存新记忆
    const saved = await sbInsertMemory(env, {
      content,
      type,
      persona_id,
      metadata,
      embedding: vector,
    });

    return jsonResp({
      saved: true,
      id: saved.id,
      persona_id: saved.persona_id,
      created_at: saved.created_at,
      cross_persona,  // 让调用方知道这次召回是不是跨 scope
      related: related.map(r => ({
        id: r.id,
        content: r.content,
        type: r.type,
        persona_id: r.persona_id,  // ★ 返回值带 persona,UI 能区分是谁的
        similarity: Math.round(r.similarity * 100) / 100,
        created_at: r.created_at,
      })),
    });

  } catch (err) {
    console.error('[memory] error:', err);
    return jsonResp({ error: String(err.message || err) }, 500);
  }
}
