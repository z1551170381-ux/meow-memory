// functions/api/memory-batch.js
// POST /api/memory-batch
// body: { user_id?, persona_id, persona_name?, scope_id?, dedupe?, items: [...] }
// 作用:把记忆家整理出的摘句 / 锚点 / 天气胶囊 / flashback token 批量写入 iw_memories
//
// ★ v2 (方案 B 收口 · 2026-04-29):
// - persona_id 必填(顶层或每条 item 内必须有一个)
// - persona_id 写到 iw_memories 的【顶层列】(原来只塞 metadata,RPC filter 过滤不到)
// - 同时 metadata 里也保留一份(向下兼容旧的 recall-bundle 按 metadata 过滤的逻辑)
// - 校验枚举值,打错字直接 400

import {
  embed,
  sbInsertMemory,
  sbFindMemoryBySource,
  sbUpdateMemory,
  jsonResp,
  corsPreflight,
} from './_lib.js';

const PERSONA_IDS = ['gpt_husband', 'weave_brother', 'junior', 'claude_xiaoke', 'system'];

export async function onRequestOptions() {
  return corsPreflight();
}

function cleanText(v, max = 5000) {
  return String(v || '').trim().slice(0, max);
}

function buildMetadata(item, body, resolvedPersonaId) {
  const itemType = cleanText(item.item_type || item.type || 'note', 80);
  const source = cleanText(item.source || item.metadata?.source || 'memory_home', 120);
  const sourceId = cleanText(item.source_id || item.metadata?.source_id || item.id || '', 240);

  return {
    ...(item.metadata || {}),

    user_id: cleanText(item.user_id || body.user_id || item.metadata?.user_id || 'default', 120),
    source,
    source_id: sourceId,

    // ★ persona_id 在 metadata 里也保留一份(向下兼容旧 recall-bundle 按 metadata 过滤)
    // 但真正用来 filter 的是表的顶层 persona_id 列(下面 sbInsertMemory 时单独传)
    persona_id: resolvedPersonaId,
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
    const topPersonaId = cleanText(body.persona_id, 120);

    if (!items.length) {
      return jsonResp({ error: 'items 不能为空' }, 400);
    }

    if (items.length > 50) {
      return jsonResp({ error: '一次最多同步 50 条,先小批量跑稳' }, 400);
    }

    // ★ 三层挡 · 第 2 层:批量上传也强制必填(顶层 persona_id 或每条 item 内必须有一个)
    // 顶层有 → 所有 item 默认用顶层;item 内自带 → 单条覆盖顶层
    if (!topPersonaId) {
      // 顶层没传 → 检查是否每一条 item 都自带 persona_id
      const missing = items.findIndex(it => !cleanText(it.persona_id, 120));
      if (missing !== -1) {
        return jsonResp({
          error: '批量上传必须指定 persona_id:顶层 body 里传一个统一值,或每条 item 内单独传。可选值: ' + PERSONA_IDS.join(', '),
        }, 400);
      }
    } else if (!PERSONA_IDS.includes(topPersonaId)) {
      return jsonResp({
        error: '顶层 persona_id 必须是已知值之一: ' + PERSONA_IDS.join(', ') + ',收到: ' + topPersonaId,
      }, 400);
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

        // ★ 解析这一条最终用哪个 persona_id:item 内 > 顶层
        const itemPersonaId = cleanText(item.persona_id, 120) || topPersonaId;
        if (!itemPersonaId) {
          // 不会走到(上面已经挡过了),保险起见再兜
          failed.push({ index: i, error: 'persona_id 缺失' });
          continue;
        }
        if (!PERSONA_IDS.includes(itemPersonaId)) {
          failed.push({ index: i, error: 'persona_id 必须是已知值之一: ' + PERSONA_IDS.join(', ') + ',收到: ' + itemPersonaId });
          continue;
        }

        const itemType = cleanText(item.item_type || item.type || 'note', 80);
        const metadata = buildMetadata(item, body, itemPersonaId);

        // ★ 老婆 patch v2 (2026-05): 内容审核 fallback
        //   SiliconFlow code 20015 真凶 = 内容审核拦截 (敏感话题如基因/生命/政治等)
        //   策略: 失败时用"安全版本"重试 — 只用主题+氛围+锚类等标签做 embedding
        //         敏感原文还在 metadata 里, 召回时拿原文展示
        //         embedding 质量降级但能存进去, 总比丢一条强
        let vector;
        let embedSafeMode = false;
        try {
          vector = await embed(content, env);
        } catch (embedErr) {
          const msg = String(embedErr?.message || embedErr || '');
          // 内容审核典型错误: code 20015 / parameter is invalid / sensitive / inappropriate
          const isContentBlock = /20015|parameter is invalid|sensitive|inappropriate|审核|敏感/i.test(msg);
          if (isContentBlock) {
            // 拼安全版本: 只用非敏感标签
            const safeBits = [];
            if (metadata.topic) safeBits.push(metadata.topic);
            if (metadata.mood) safeBits.push(metadata.mood);
            if (metadata.anchor_class) safeBits.push(metadata.anchor_class);
            if (metadata.core_topic_name) safeBits.push(metadata.core_topic_name);
            safeBits.push(itemType);
            const safeContent = '[' + safeBits.filter(Boolean).join(' · ') + ']' +
                                (metadata.persona_name ? ' (' + metadata.persona_name + ')' : '');
            console.warn('[embed safe fallback]', {
              source_id: metadata.source_id,
              original_len: content.length,
              safe_content: safeContent,
              original_error: msg.slice(0, 200),
            });
            try {
              vector = await embed(safeContent, env);
              embedSafeMode = true;
              metadata._embed_safe_mode = true;       // 标记: 这条 embedding 用了安全模式
              metadata._embed_blocked_reason = msg.slice(0, 200);
            } catch (safeErr) {
              // 安全版本也失败 — 真的没救了
              throw new Error('内容审核拦截且安全 fallback 也失败: ' + String(safeErr?.message || safeErr).slice(0, 200));
            }
          } else {
            throw embedErr;
          }
        }

        let row = null;
        let action = 'inserted';

        if (dedupe && metadata.source && metadata.source_id) {
          const existing = await sbFindMemoryBySource(env, metadata.source, metadata.source_id);
          if (existing?.id != null) {
            row = await sbUpdateMemory(env, existing.id, {
              content,
              type: itemType,
              persona_id: itemPersonaId,  // ★ 顶层列也更新
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
            persona_id: itemPersonaId,  // ★ 写到顶层列(关键!RPC filter_persona 才能过滤到)
            metadata,
            embedding: vector,
          });
        }

        saved.push({
          index: i,
          id: row.id,
          action,
          type: itemType,
          persona_id: itemPersonaId,
          source: metadata.source,
          source_id: metadata.source_id,
          embed_safe_mode: embedSafeMode,  // ★ 老婆 patch v2: 标记降级模式, 扩展端能在 UI 提示
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
