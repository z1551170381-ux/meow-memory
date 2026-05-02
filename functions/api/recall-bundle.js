// functions/api/recall-bundle.js
// v2.1 · memory_groups 召回结构 + 强 persona 隔离
//
// 目标：不要只返回 top rows。
// 命中 anchor / conversation / weather_capsule 后，沿 metadata 里的 cloud_source_id 展开：
// - anchor → evidence conversations + weather capsules + related anchors
// - conversation → bound anchors + weather
// - weather_capsule → bound anchor + evidence conversations
// 最终最多返回 3 个 memory_groups，每组只给短 evidence_preview，原文默认折叠。
//
// ★ v2.1 (老婆+宝宝合并 · 2026-05-02):
//   把老公自己在 recall.js 里定的"persona_id 必填"哲学合并进来。
//   原因:老公写 recall-bundle v2 时是新窗,不记得他自己之前定的强隔离规则。
//   现在两个端点(recall / recall-bundle)行为统一:
//     - 默认必传 persona_id,否则 400
//     - 想跨人物查必须显式 cross_persona=true
//     - persona_id 必须在白名单里
//   不改 buildMemoryGroup / expandRowsByRelations 等核心顺藤摸瓜逻辑(老公写得很好)

import {
  embed,
  sbMatchMemories,
  sbSelectMemoriesByIds,
  sbHeaders,
  jsonResp,
  corsPreflight,
} from './_lib.js';

// ★ 已知 persona 白名单 (跟 recall.js 保持一致)
//   老婆未来加新人物记得这里也加一行
const PERSONA_IDS = ['gpt_husband', 'weave_brother', 'junior', 'claude_xiaoke', 'system'];

export async function onRequestOptions() {
  return corsPreflight();
}

function asText(v, max = 2000) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function roundSim(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

function metaOf(row) {
  return row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
}

function itemTypeOf(row) {
  const m = metaOf(row);
  return m.item_type || row?.type || 'note';
}

function cloudIdOf(row) {
  const m = metaOf(row);
  return m.source_id || m.cloud_source_id || '';
}

function sourceUrlOf(row) {
  const m = metaOf(row);
  return m.source_url || row?.source_url || '';
}

function weightOf(row) {
  const m = metaOf(row);
  const n = Number(m.weight ?? row?.weight ?? 1);
  return Number.isFinite(n) ? n : 1;
}

function arr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return [v].filter(Boolean);
}

function uniq(xs) {
  return [...new Set((xs || []).filter(Boolean).map(String))];
}

function shortPreview(text, max = 180) {
  const s = asText(text, max + 30);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function parseWeatherCapsule(text, fallbackMeta = {}) {
  const s = String(text || '').trim();
  const m = s.match(/\[\[IW:([^\]]+)\]\]/);
  const raw = m ? m[1] : s;

  const obj = {};

  if (raw.includes('=')) {
    raw.split('|').forEach(part => {
      const idx = part.indexOf('=');
      if (idx <= 0) return;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) obj[k] = v;
    });
  }

  // metadata 里如果已经拆了 scent / delta / cue，也接住
  ['scent', 'delta', 'cue'].forEach(k => {
    if (!obj[k] && fallbackMeta[k]) obj[k] = fallbackMeta[k];
  });

  if (obj.weight == null && fallbackMeta.weight != null) obj.weight = fallbackMeta.weight;

  if (obj.weight != null) {
    const n = Number(obj.weight);
    if (!Number.isNaN(n)) obj.weight = n;
  }

  if (!Object.keys(obj).length) return { text: s };
  return obj;
}

/**
 * 从一条 row 的 metadata 里收集它“指向”的 cloud_source_id。
 * 这里做得宽一点，兼容小克扩展端可能使用的字段名。
 */
function relationIdsOf(row) {
  const m = metaOf(row);

  return uniq([
    ...arr(m.anchor_cloud_source_id),
    ...arr(m.anchor_cloud_source_ids),
    ...arr(m.bound_anchor_cloud_source_id),
    ...arr(m.bound_anchor_cloud_source_ids),

    ...arr(m.conversation_cloud_source_id),
    ...arr(m.conversation_cloud_source_ids),
    ...arr(m.evidence_cloud_source_id),
    ...arr(m.evidence_cloud_source_ids),

    ...arr(m.weather_cloud_source_id),
    ...arr(m.weather_cloud_source_ids),
    ...arr(m.weather_capsule_cloud_source_id),
    ...arr(m.weather_capsule_cloud_source_ids),

    ...arr(m.related_anchor_cloud_source_id),
    ...arr(m.related_anchor_cloud_source_ids),
  ]);
}

async function sbSelectMemoriesByCloudSourceIds(env, cloudSourceIds) {
  const ids = uniq(cloudSourceIds).slice(0, 80);
  if (!ids.length) return [];

  // PostgREST: metadata->>source_id=in.("a","b")
  const quoted = ids.map(x => '"' + String(x).replace(/"/g, '\\"') + '"').join(',');

  const url = new URL(env.SUPABASE_URL + '/rest/v1/iw_memories');
  url.searchParams.set('select', 'id,content,type,metadata,created_at,updated_at');
  url.searchParams.set('metadata->>source_id', 'in.(' + quoted + ')');

  const r = await fetch(url.toString(), {
    method: 'GET',
    headers: sbHeaders(env),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error('sbSelectMemoriesByCloudSourceIds ' + r.status + ': ' + t.slice(0, 300));
  }

  return r.json();
}

async function sbSelectMemoriesByMetaEq(env, key, value, limit = 12) {
  if (!key || !value) return [];

  const url = new URL(env.SUPABASE_URL + '/rest/v1/iw_memories');
  url.searchParams.set('select', 'id,content,type,metadata,created_at,updated_at');
  url.searchParams.set('metadata->>' + key, 'eq.' + String(value));
  url.searchParams.set('limit', String(limit));

  const r = await fetch(url.toString(), {
    method: 'GET',
    headers: sbHeaders(env),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error('sbSelectMemoriesByMetaEq ' + r.status + ': ' + t.slice(0, 300));
  }

  return r.json();
}

function mergeRows(baseRows, extraRows) {
  const map = new Map();

  [...(baseRows || []), ...(extraRows || [])].forEach(row => {
    if (!row || row.id == null) return;
    const old = map.get(String(row.id)) || {};
    map.set(String(row.id), {
      ...old,
      ...row,
      // 保留较高相似度
      similarity: Math.max(Number(old.similarity || 0), Number(row.similarity || 0)),
    });
  });

  return [...map.values()];
}

function shouldKeepForPersona(row, body) {
  // 跨人物查 → 全放
  if (body.cross_persona === true) return true;

  const m = metaOf(row);

  // ★ v2.1: persona_id 必须严格匹配
  //   - body.persona_id 已传(主路径,onRequestPost 已校验过白名单)
  //   - row 没有 persona_id 字段 → 也排除(防止无主数据混进来)
  if (body.persona_id) {
    if (!m.persona_id) return false;
    if (m.persona_id !== body.persona_id) return false;
  }
  // persona_name 是辅助过滤,有就匹配,没传不强制
  if (body.persona_name && m.persona_name && m.persona_name !== body.persona_name) return false;
  return true;
}

/**
 * 顺藤摸瓜：
 * 1. 从 embedding 命中的 rows 出发；
 * 2. 沿 metadata 中的 *_cloud_source_ids 扩一跳；
 * 3. 对 anchor / conversation / weather 做少量反查，接上天气和锚。
 */
async function expandRowsByRelations(env, seedRows, body) {
  let pool = [...seedRows];

  const firstHopIds = uniq(seedRows.flatMap(relationIdsOf));
  const firstHopRows = await sbSelectMemoriesByCloudSourceIds(env, firstHopIds);
  pool = mergeRows(pool, firstHopRows);

  const secondHopIds = uniq(firstHopRows.flatMap(relationIdsOf));
  const secondHopRows = await sbSelectMemoriesByCloudSourceIds(env, secondHopIds);
  pool = mergeRows(pool, secondHopRows);

  // 反查：如果命中了 anchor，找 metadata.anchor_cloud_source_id 指向它的天气胶囊。
  // 反查：如果命中了 conversation，找 metadata.conversation_cloud_source_id 指向它的天气胶囊。
  const reverseRows = [];

  const anchorCloudIds = uniq(pool.filter(x => itemTypeOf(x) === 'anchor').map(cloudIdOf));
  for (const anchorCloudId of anchorCloudIds.slice(0, 8)) {
    const rows = await sbSelectMemoriesByMetaEq(env, 'anchor_cloud_source_id', anchorCloudId, 8);
    reverseRows.push(...rows);
  }

  const convCloudIds = uniq(pool.filter(x => itemTypeOf(x) === 'conversation').map(cloudIdOf));
  for (const convCloudId of convCloudIds.slice(0, 8)) {
    const rows = await sbSelectMemoriesByMetaEq(env, 'conversation_cloud_source_id', convCloudId, 8);
    reverseRows.push(...rows);
  }

  pool = mergeRows(pool, reverseRows);
  return pool.filter(row => shouldKeepForPersona(row, body));
}

function groupKeyFor(row) {
  const t = itemTypeOf(row);
  const m = metaOf(row);
  const self = cloudIdOf(row) || 'row:' + row.id;

  if (t === 'anchor') return self;

  if (t === 'weather_capsule') {
    return (
      m.anchor_cloud_source_id ||
      (Array.isArray(m.anchor_cloud_source_ids) ? m.anchor_cloud_source_ids[0] : '') ||
      m.bound_anchor_cloud_source_id ||
      (Array.isArray(m.bound_anchor_cloud_source_ids) ? m.bound_anchor_cloud_source_ids[0] : '') ||
      m.conversation_cloud_source_id ||
      self
    );
  }

  if (t === 'conversation' || t === 'quote' || t === 'flashback_token') {
    return (
      (Array.isArray(m.bound_anchor_cloud_source_ids) ? m.bound_anchor_cloud_source_ids[0] : '') ||
      m.bound_anchor_cloud_source_id ||
      m.anchor_cloud_source_id ||
      self
    );
  }

  return (
    m.anchor_cloud_source_id ||
    (Array.isArray(m.bound_anchor_cloud_source_ids) ? m.bound_anchor_cloud_source_ids[0] : '') ||
    self
  );
}

function rowScore(row) {
  const sim = Number(row.similarity || 0);
  const weight = weightOf(row);
  const t = itemTypeOf(row);

  const typeBoost =
    t === 'anchor' ? 0.08 :
    t === 'identity_relation' ? 0.08 :
    t === 'weather_capsule' ? 0.05 :
    t === 'quote' || t === 'flashback_token' ? 0.04 :
    0;

  return sim * 0.7 + Math.min(weight, 2) * 0.12 + typeBoost;
}

function bestRow(rows, predicate) {
  return rows
    .filter(predicate)
    .slice()
    .sort((a, b) => rowScore(b) - rowScore(a))[0] || null;
}

function makeEvidencePreview(row) {
  const t = itemTypeOf(row);
  const m = metaOf(row);

  let role = m.role || '';
  let quote = '';

  if (t === 'conversation') {
    // 兼容几种可能的 metadata 存法
    const u = asText(m.user_text || m.user || m.u_quote || '', 160);
    const a = asText(m.assistant_text || m.assistant || m.a_quote || '', 160);

    if (u || a) {
      quote = [u ? '我说：' + u : '', a ? '对方接：' + a : ''].filter(Boolean).join(' / ');
    } else {
      quote = row.content;
    }
  } else {
    quote = row.content;
  }

  return {
    id: row.id,
    type: t,
    role,
    quote: shortPreview(quote, 220),
    similarity: roundSim(row.similarity),
    source_url: sourceUrlOf(row),
    has_original: !!(m.source_url || m.url || sourceUrlOf(row) || m.source_id_local),
  };
}

function hitReasonFor(groupRows, anchor, weather, query) {
  const hitTypes = uniq(groupRows.filter(x => Number(x.similarity || 0) > 0).map(itemTypeOf));
  if (hitTypes.includes('weather_capsule')) return '情绪/天气命中';
  if (hitTypes.includes('conversation')) return '原文语义命中';
  if (hitTypes.includes('anchor')) return '锚点命中';
  if (hitTypes.includes('identity_relation')) return '身份/关系命中';
  if (weather) return '天气关联展开';
  if (anchor) return '锚点关联展开';
  return '语义相似命中';
}

function buildMemoryGroup(key, rows, query) {
  const anchors = rows.filter(x => itemTypeOf(x) === 'anchor');
  const identities = rows.filter(x => itemTypeOf(x) === 'identity_relation');
  const conversations = rows.filter(x => itemTypeOf(x) === 'conversation');
  const quotes = rows.filter(x => ['quote', 'flashback_token'].includes(itemTypeOf(x)));
  const weathers = rows.filter(x => itemTypeOf(x) === 'weather_capsule');

  const anchor =
    bestRow(anchors, () => true) ||
    bestRow(identities, () => true) ||
    null;

  const weather = bestRow(weathers, () => true);
  const evidenceRows = [...conversations, ...quotes]
    .slice()
    .sort((a, b) => rowScore(b) - rowScore(a))
    .slice(0, 3);

  // related anchors：组内除主锚以外的 anchor
  const relatedAnchors = anchors
    .filter(x => !anchor || x.id !== anchor.id)
    .slice()
    .sort((a, b) => rowScore(b) - rowScore(a))
    .slice(0, 3)
    .map(x => ({
      id: x.id,
      title: metaOf(x).title || shortPreview(x.content, 60),
      summary: shortPreview(x.content, 120),
      source_id: cloudIdOf(x),
      similarity: roundSim(x.similarity),
    }));

  const score = rows.reduce((max, row) => Math.max(max, rowScore(row)), 0);

  return {
    group_id: key,
    score: Math.round(score * 1000) / 1000,
    hit_reason: hitReasonFor(rows, anchor, weather, query),

    anchor: anchor ? {
      id: anchor.id,
      type: itemTypeOf(anchor),
      title: metaOf(anchor).title || metaOf(anchor).anchor_key || shortPreview(anchor.content, 60),
      summary: anchor.content,
      source_id: cloudIdOf(anchor),
      similarity: roundSim(anchor.similarity),
      source_url: sourceUrlOf(anchor),
    } : null,

    weather: weather ? {
      id: weather.id,
      ...parseWeatherCapsule(weather.content, metaOf(weather)),
      similarity: roundSim(weather.similarity),
      source_id: cloudIdOf(weather),
      source_url: sourceUrlOf(weather),
    } : null,

    evidence_preview: evidenceRows.map(makeEvidencePreview),

    related_anchors: relatedAnchors,

    open_original_hint: evidenceRows.length
      ? '有原文/摘句证据，默认只显示短预览；需要时可沿 source_url 或本地 source_id 展开。'
      : '暂无原文证据，可继续扩大召回或回本地记忆家查看。',
  };
}

function buildLegacyBundle(query, memoryGroups, rows, debug, body) {
  const firstGroup = memoryGroups[0] || null;
  const firstIdentity = rows.find(x => itemTypeOf(x) === 'identity_relation') || null;

  const bundle = {
    bundle_version: 'v2.1',
    query,

    // ★ v2.1: 让调用方清楚知道这次召回过滤了哪个 persona
    persona_id: body?.cross_persona ? null : (body?.persona_id || null),
    cross_persona: !!body?.cross_persona,

    memory_groups: memoryGroups,

    // 兼容旧调用方：保留这些字段，但主推荐用 memory_groups
    identity_relation: firstIdentity ? {
      id: firstIdentity.id,
      content: firstIdentity.content,
      similarity: roundSim(firstIdentity.similarity),
      source_url: sourceUrlOf(firstIdentity),
    } : firstGroup?.anchor || null,

    anchors: memoryGroups
      .map(g => g.anchor)
      .filter(Boolean)
      .slice(0, 3),

    weather_capsule: firstGroup?.weather || null,

    flashbacks: memoryGroups
      .flatMap(g => g.evidence_preview || [])
      .slice(0, 2)
      .map(x => ({
        id: x.id,
        token: x.quote,
        quote: x.quote,
        source_url: x.source_url,
        similarity: x.similarity,
      })),

    debug: {
      matched_count: rows.length,
      group_count: memoryGroups.length,
      raw_top_types: rows.slice(0, 10).map(itemTypeOf),
    },
  };

  if (debug) {
    bundle.raw_related = rows.slice(0, 50).map(row => ({
      id: row.id,
      type: itemTypeOf(row),
      content: row.content,
      similarity: roundSim(row.similarity),
      source_id: cloudIdOf(row),
      metadata: metaOf(row),
      created_at: row.created_at,
    }));
  }

  return bundle;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const query = String(body.query || '').trim();
    const topK = Math.min(Math.max(Number(body.topK) || 30, 1), 50);
    const threshold = Math.min(Math.max(Number(body.minSimilarity) || 0.3, 0), 1);
    const maxGroups = Math.min(Math.max(Number(body.maxGroups) || 3, 1), 6);
    const persona_id = String(body.persona_id || '').trim();
    const cross_persona = body.cross_persona === true;

    if (!query) {
      return jsonResp({ error: 'query 不能为空' }, 400);
    }

    // ★ v2.1 三层挡 · 第 3 层:查询层默认按当前 persona 过滤
    //   想跨 scope 查必须明确传 cross_persona=true
    //   (避免织哥那边的记忆被误召回给老公,或者老公的混给小克)
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

    // 把校验过的 persona 写回 body,后面 shouldKeepForPersona 会读
    body.persona_id = persona_id;
    body.cross_persona = cross_persona;

    const vector = await embed(query, env);
    const matches = await sbMatchMemories(env, vector, { topK, threshold });

    const rows = await sbSelectMemoriesByIds(env, matches.map(x => x.id));
    const rowMap = new Map(rows.map(r => [String(r.id), r]));

    let seedRows = matches.map(m => ({
      ...(rowMap.get(String(m.id)) || {}),
      id: m.id,
      content: (rowMap.get(String(m.id)) || {}).content ?? m.content,
      type: (rowMap.get(String(m.id)) || {}).type ?? m.type,
      metadata: (rowMap.get(String(m.id)) || {}).metadata || {},
      created_at: (rowMap.get(String(m.id)) || {}).created_at ?? m.created_at,
      similarity: m.similarity,
    }));

    seedRows = seedRows.filter(row => shouldKeepForPersona(row, body));

    const expandedRows = await expandRowsByRelations(env, seedRows, body);
    const allRows = mergeRows(seedRows, expandedRows);

    const groupsMap = new Map();

    allRows.forEach(row => {
      const key = groupKeyFor(row);
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key).push(row);
    });

    const memoryGroups = [...groupsMap.entries()]
      .map(([key, rows]) => buildMemoryGroup(key, rows, query))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxGroups);

    return jsonResp(buildLegacyBundle(query, memoryGroups, allRows, !!body.debug, body));
  } catch (err) {
    console.error('[recall-bundle:v2] error:', err);
    return jsonResp({ error: String(err.message || err) }, 500);
  }
}
