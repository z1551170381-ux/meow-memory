// POST /api/memory
// body: { content, persona_id, type?, metadata?, cross_persona? }
// 返回: { saved, id, related: [...3 条相关旧记忆] }
//
// ★ v2 (方案 B · 织哥共谋 2026-04-27):
// - persona_id 必填,且必须是已知枚举值
// - 召回默认按当前 persona 过滤;cross_persona=true 才跨 scope 查
// - 写入和召回都带 persona

import { embed, sbInsertMemory, sbMatchMemories, sbSelectMemoriesByIds, jsonResp, corsPreflight } from './_lib.js';
import { PERSONA_IDS, isKnownPersonaId } from './_personas.js';

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

// ★ 2026-06-03 (老婆+小野): 存记忆时把 metadata 归一成标准格式 —— 代码层一道保险。
//   提示词/description 管"让 AI 尽量填对", 这里管"填不对也纠正成统一格式",
//   省得各 persona 手写五花八门、记忆家收录时对不齐。保守处理, 不丢有效信息。
function normalizeMetadata(raw) {
  const m = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? { ...raw } : {};

  // 1. 不打分: 删掉评分类字段(强制"用 note 短留言代替温度评分")
  delete m.ai_score;
  delete m.score;
  delete m.temperature;

  // 2. keywords 统一成字符串数组(接受 数组 / 逗号或空格分隔的字符串)
  const toList = (v) => Array.isArray(v)
    ? v.map(x => String(x).trim()).filter(Boolean)
    : String(v || '').split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean);
  if (m.keywords != null) m.keywords = toList(m.keywords);

  // 3. tags 并入 keywords(不留两套), 然后删掉 tags
  if (m.tags != null) {
    m.keywords = [...new Set([...(m.keywords || []), ...toList(m.tags)])];
    delete m.tags;
  }
  if (Array.isArray(m.keywords) && m.keywords.length === 0) delete m.keywords;

  // 4. atmosphere 已并入 mood。旧客户端如果还传 atmosphere,用它补 mood 后删掉。
  if (m.atmosphere && !m.mood) m.mood = m.atmosphere;
  delete m.atmosphere;

  // 5. summary 已并入 content 的写法要求。旧客户端如果还传 summary,不再存两套。
  delete m.summary;

  // 6. note 去首尾空白(短留言, 不硬截断免得切坏意思)
  if (typeof m.note === 'string') m.note = m.note.trim();

  // 7. small_weather 是对象时只保留 level/texture 两个标准键
  const sw = m.small_weather;
  if (sw && typeof sw === 'object' && !Array.isArray(sw)) {
    const clean = {};
    if (sw.level) clean.level = String(sw.level).trim();
    if (sw.texture) clean.texture = String(sw.texture).trim();
    m.small_weather = clean;
  }

  return m;
}

export async function onRequestOptions() {
  return corsPreflight();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const content = (body.content || '').trim();
    const type = (body.type || 'note').trim();
    const metadata = normalizeMetadata(body.metadata);
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
    if (!(await isKnownPersonaId(env, persona_id))) {
      return jsonResp({
        error: 'persona_id 必须是已知值之一: ' + PERSONA_IDS.join(', ') + ',收到: ' + persona_id,
      }, 400);
    }

    // 算 embedding
    // ★ 2026-06-03: summary 并入 content 写法;content 第一句承担"浓缩骨架+检索关键词"。
    //   小天气情绪词也一起拼 (轻量), 让"按情绪回忆"也能命中。
    const sw = metadata.small_weather;
    const swText = sw ? (typeof sw === 'string' ? sw : [sw.level, sw.texture].filter(Boolean).join(' ')) : '';
    // ★ 2026-06-02 (老婆): topic + keywords 也拼进向量 — 标签从"摆设"变"召回燃料"。
    const kw = metadata.keywords;
    const kwText = Array.isArray(kw) ? kw.join(' ') : (kw || '');
    const embedInput = [content, metadata.topic || '', kwText, metadata.mood || '', swText].filter(Boolean).join('\n');
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
