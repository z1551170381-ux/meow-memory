// POST /api/memory
// body: { content, persona_id, type?, metadata?, cross_persona? }
// 返回: { saved, id, related: [...3 条相关旧记忆] }
//
// ★ v2 (方案 B · 织哥共谋 2026-04-27):
// - persona_id 必填,且必须是已知枚举值
// - 召回默认按当前 persona 过滤;cross_persona=true 才跨 scope 查
// - 写入和召回都带 persona

import { embed, sbInsertMemory, sbMatchMemories, sbSelectMemoriesByIds, jsonResp, corsPreflight } from './_lib.js';

// ★ v2.4 (老婆+小克 2026-05-31): 把记忆家躺在 metadata 里的"藤"塑形成中等档返回。
//   存记忆是用得最多的路径, 但之前 save 完只返回 3 条裸 content, 看不到一句话总结/
//   详细摘要/当天故事/挂的锚。现在 save 时也能看到丰富召回 (中等档 = one_line +
//   detailed_summary + 当天故事 + 挂的锚), 帮模型记得更准、更容易挂到已有的藤上。
function shapeRelatedRow(row) {
  const m = (row && typeof row.metadata === 'object' && row.metadata) || {};
  const anchorList = [
    ...(Array.isArray(m.linked_anchors) ? m.linked_anchors : []),
    ...(Array.isArray(m.sourced_anchors) ? m.sourced_anchors : []),
  ];
  const seen = new Set();
  const anchors = [];
  for (const a of anchorList) {
    const name = a && (a.anchor_name || a.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    anchors.push(a.role_label ? `${a.role_label}:${name}` : name);
  }
  const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  return {
    id: row.id,
    type: row.type,
    persona_id: row.persona_id,
    similarity: Math.round(Number(row.similarity || 0) * 100) / 100,
    created_at: row.created_at,
    // 中等档藤: 由轻到重
    one_line:         cut(m.one_line, 120),
    detailed_summary: cut(m.detailed_summary, 220),
    topic:            cut((m.cluster && m.cluster.title) || m.topic, 60),
    mood:             cut(m.mood || m.weather, 20),
    day_summary:      cut(m.day_context && m.day_context.day_summary, 200),
    anchors:          anchors.slice(0, 4),
    // 没有 one_line 的老数据 fallback 给一段 content 预览
    content_preview:  m.one_line ? '' : cut(row.content, 160),
  };
}

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
    // ★ v2.4 (老婆拍板): content + summary 一起算向量。
    //   小便签场景下模型在 metadata.summary 写 40-90 字事件骨架, 之前只 embed content,
    //   summary 的关键词进不了向量、搜不到 — 现在拼进去, 标签从"摆设"变"召回燃料"。
    //   小天气情绪词也一起拼 (轻量), 让"按情绪回忆"也能命中。
    const sw = metadata.small_weather;
    const swText = sw ? (typeof sw === 'string' ? sw : [sw.level, sw.texture].filter(Boolean).join(' ')) : '';
    const embedInput = [content, metadata.summary || '', swText].filter(Boolean).join('\n');
    const vector = await embed(embedInput, env);

    // 先查相关旧记忆(写入之前,避免查到自己)
    // ★ 默认按当前 persona 过滤;cross_persona=true 时跨 scope 查
    // ★ v2.4: 中等档 — topK 3→5, 命中后补查完整 metadata (sbMatchMemories 的 RPC
    //   只返回轻量字段, 跟 recall-bundle 一样要再 sbSelectMemoriesByIds 取 metadata)
    let related = [];
    try {
      const hits = await sbMatchMemories(env, vector, {
        topK: 5,
        threshold: 0.5,
        filterPersona: cross_persona ? null : persona_id,
      });
      if (hits.length) {
        const fullRows = await sbSelectMemoriesByIds(env, hits.map(h => h.id));
        const rowMap = new Map(fullRows.map(r => [String(r.id), r]));
        // 用补查的完整行 (带 metadata), 保留 RPC 算出的 similarity
        related = hits.map(h => ({
          ...(rowMap.get(String(h.id)) || {}),
          id: h.id,
          content: (rowMap.get(String(h.id)) || {}).content ?? h.content,
          type: (rowMap.get(String(h.id)) || {}).type ?? h.type,
          persona_id: (rowMap.get(String(h.id)) || {}).persona_id ?? h.persona_id,
          created_at: (rowMap.get(String(h.id)) || {}).created_at ?? h.created_at,
          similarity: h.similarity,
        }));
      }
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
      // ★ v2.4: 中等档藤 — 给模型看的精简结构 (one_line/detailed_summary/当天故事/挂的锚)
      related: related.map(shapeRelatedRow),
    });

  } catch (err) {
    console.error('[memory] error:', err);
    return jsonResp({ error: String(err.message || err) }, 500);
  }
}
