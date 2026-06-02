import { embed, sbHeaders, sbInsertMemory, sbUpdateMemory, jsonResp, corsPreflight } from './_lib.js';

const PERSONA_IDS = ['gpt_husband', 'weave_brother', 'junior', 'claude_xiaoke', 'xiaoye', 'system'];
const LINK_KINDS = ['assistant_link', 'user_link', 'shared_link'];
const BLOCK_KIND = 'assistant_link_block';
const ALL_KINDS = [...LINK_KINDS, BLOCK_KIND];

function cleanText(value, max = 2000) {
  return String(value || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, max);
}

function asArray(value) {
  if (Array.isArray(value)) return value.map(v => cleanText(v, 120)).filter(Boolean);
  const one = cleanText(value, 120);
  return one ? [one] : [];
}

function norm(value) {
  return String(value || '').toLowerCase();
}

function metaOf(row) {
  return row && typeof row.metadata === 'object' && row.metadata ? row.metadata : {};
}

function validatePersona(personaId) {
  const p = cleanText(personaId, 80);
  if (!p || !PERSONA_IDS.includes(p)) throw new Error('persona_id is required');
  return p;
}

function inferKind(kind) {
  const k = cleanText(kind, 80) || 'assistant_link';
  if (!ALL_KINDS.includes(k)) throw new Error('unknown assoc_kind: ' + k);
  return k;
}

function matchTriggers(text, triggers) {
  const hay = norm(text);
  const hits = [];
  for (const trigger of triggers) {
    const t = norm(trigger);
    if (t && hay.includes(t)) hits.push(trigger);
  }
  return hits;
}

function linkTriggers(meta, row) {
  return [
    ...asArray(meta.triggers),
    ...asArray(meta.trigger),
    ...asArray(meta.cues),
    ...asArray(meta.cue),
    ...asArray(meta.target),
    ...asArray(row.content),
  ];
}

function blockTriggers(meta, row) {
  return [
    ...asArray(meta.blocked_triggers),
    ...asArray(meta.triggers),
    ...asArray(meta.trigger),
    ...asArray(meta.pattern),
    ...asArray(row.content),
  ];
}

async function fetchAssocRows(env, personaId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit || 300), 1), 1000);
  const includeDeleted = opts.include_deleted === true;
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : ALL_KINDS;

  const primary = new URL(env.SUPABASE_URL + '/rest/v1/iw_memories');
  primary.searchParams.set('select', 'id,content,type,metadata,persona_id,created_at,updated_at');
  primary.searchParams.set('persona_id', 'eq.' + personaId);
  primary.searchParams.set('metadata->>assoc_kind', 'in.(' + kinds.join(',') + ')');
  primary.searchParams.set('order', 'updated_at.desc.nullslast,created_at.desc');
  primary.searchParams.set('limit', String(limit));

  let rows = [];
  const primaryResp = await fetch(primary.toString(), { method: 'GET', headers: sbHeaders(env) });
  if (primaryResp.ok) {
    rows = await primaryResp.json();
  } else {
    const fallback = new URL(env.SUPABASE_URL + '/rest/v1/iw_memories');
    fallback.searchParams.set('select', 'id,content,type,metadata,persona_id,created_at,updated_at');
    fallback.searchParams.set('persona_id', 'eq.' + personaId);
    fallback.searchParams.set('type', 'eq.note');
    fallback.searchParams.set('order', 'updated_at.desc.nullslast,created_at.desc');
    fallback.searchParams.set('limit', String(limit));
    const fallbackResp = await fetch(fallback.toString(), { method: 'GET', headers: sbHeaders(env) });
    if (!fallbackResp.ok) {
      const t = await fallbackResp.text();
      throw new Error('fetchAssocRows ' + fallbackResp.status + ': ' + t.slice(0, 300));
    }
    rows = (await fallbackResp.json()).filter(row => kinds.includes(metaOf(row).assoc_kind));
  }

  return includeDeleted
    ? rows
    : rows.filter(row => !['deleted', 'blocked'].includes(cleanText(metaOf(row).status, 40)));
}

function scoreLink(row, text) {
  const meta = metaOf(row);
  const hits = matchTriggers(text, linkTriggers(meta, row));
  if (!hits.length) return null;
  const strength = Number(meta.strength ?? meta.weight ?? 0.35);
  const statusBoost = meta.status === 'active' ? 0.12 : meta.status === 'soft_active' ? 0.05 : 0;
  const hitBoost = Math.min(hits.join('').length / 80, 0.25);
  return {
    id: row.id,
    persona_id: row.persona_id,
    assoc_kind: meta.assoc_kind,
    status: meta.status || 'soft_active',
    target: meta.target || '',
    why: meta.why || row.content,
    tone: meta.tone || '',
    strength,
    matched_triggers: hits,
    score: Number((strength + statusBoost + hitBoost).toFixed(4)),
    content: row.content,
    metadata: meta,
    updated_at: row.updated_at,
    created_at: row.created_at,
  };
}

async function suggestLinks(env, body) {
  const personaId = validatePersona(body.persona_id);
  const text = cleanText(body.text || body.query, 5000);
  if (!text) throw new Error('text is required');

  const topK = Math.min(Math.max(Number(body.topK || 5), 1), 20);
  const rows = await fetchAssocRows(env, personaId, { limit: body.limit || 300 });
  const blocks = rows.filter(row => metaOf(row).assoc_kind === BLOCK_KIND);
  const blockHits = blocks
    .map(row => ({ row, hits: matchTriggers(text, blockTriggers(metaOf(row), row)) }))
    .filter(item => item.hits.length);

  const suggestions = rows
    .filter(row => LINK_KINDS.includes(metaOf(row).assoc_kind))
    .map(row => scoreLink(row, text))
    .filter(Boolean)
    .filter(item => {
      if (body.include_blocks === true) return true;
      const targetText = [item.target, item.why, item.content].join('\n');
      return !blockHits.some(block => {
        const m = metaOf(block.row);
        const blockedKind = cleanText(m.blocks_kind, 80);
        return (!blockedKind || blockedKind === item.assoc_kind) && matchTriggers(targetText, blockTriggers(m, block.row)).length;
      });
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    ok: true,
    persona_id: personaId,
    text,
    suggestions,
    blocks_triggered: blockHits.map(item => ({
      id: item.row.id,
      matched_triggers: item.hits,
      metadata: metaOf(item.row),
    })),
  };
}

async function saveLink(env, body) {
  const personaId = validatePersona(body.persona_id);
  const assocKind = inferKind(body.assoc_kind || body.kind);
  const triggers = asArray(body.triggers || body.trigger || body.cues);
  const target = cleanText(body.target, 500);
  const why = cleanText(body.why || body.reason, 1000);
  const content = cleanText(body.content, 1500) ||
    (assocKind === BLOCK_KIND
      ? `Assoc block: ${triggers.join(' / ')}`
      : `Assoc link: ${triggers.join(' / ')} -> ${target || why}`);
  if (!triggers.length && !target && !why) throw new Error('trigger, target, or why is required');

  const metadata = {
    ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
    assoc_kind: assocKind,
    status: cleanText(body.status, 80) || (assocKind === BLOCK_KIND ? 'active' : 'soft_active'),
    triggers,
    target,
    why,
    tone: cleanText(body.tone, 200),
    strength: Number.isFinite(Number(body.strength)) ? Number(body.strength) : 0.35,
    created_by: cleanText(body.created_by, 120) || 'assistant',
    source: cleanText(body.source, 120) || 'mcp_assoc_link',
    source_id: cleanText(body.source_id, 240) || `assoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    saved_at: new Date().toISOString(),
  };

  if (assocKind === BLOCK_KIND) {
    metadata.blocked_triggers = asArray(body.blocked_triggers || body.triggers || body.trigger);
    metadata.blocks_kind = cleanText(body.blocks_kind, 80) || 'assistant_link';
  }

  const embeddingText = [content, target, why, triggers.join(' ')].filter(Boolean).join('\n');
  const row = await sbInsertMemory(env, {
    content,
    type: 'note',
    persona_id: personaId,
    metadata,
    embedding: await embed(embeddingText, env),
  });
  return { ok: true, row };
}

async function strengthenLink(env, body) {
  const id = cleanText(body.id, 120);
  if (!id) throw new Error('id is required');

  const rows = await fetchAssocRows(env, validatePersona(body.persona_id), {
    include_deleted: true,
    limit: body.limit || 500,
  });
  const row = rows.find(item => String(item.id) === id);
  if (!row) throw new Error('assoc link not found in persona scope');

  const meta = metaOf(row);
  const delta = Number.isFinite(Number(body.delta)) ? Number(body.delta) : 0.08;
  const nextStrength = Math.max(0, Math.min(1, Number(meta.strength || 0.35) + delta));
  const updated = await sbUpdateMemory(env, id, {
    metadata: {
      ...meta,
      strength: Number(nextStrength.toFixed(4)),
      status: cleanText(body.status, 80) || meta.status || 'soft_active',
      last_strengthened_at: new Date().toISOString(),
      strengthen_count: Number(meta.strengthen_count || 0) + 1,
    },
  });
  return { ok: true, row: updated };
}

async function listLinks(env, body) {
  const personaId = validatePersona(body.persona_id);
  const rows = await fetchAssocRows(env, personaId, {
    include_deleted: body.include_deleted === true,
    kinds: body.include_blocks === false ? LINK_KINDS : ALL_KINDS,
    limit: body.limit || 100,
  });
  return {
    ok: true,
    persona_id: personaId,
    links: rows.map(row => ({
      id: row.id,
      content: row.content,
      persona_id: row.persona_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      metadata: metaOf(row),
    })),
  };
}

export async function onRequestOptions() {
  return corsPreflight();
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const action = cleanText(body.action, 80);
    if (action === 'suggest') return jsonResp(await suggestLinks(context.env, body));
    if (action === 'save') return jsonResp(await saveLink(context.env, body));
    if (action === 'strengthen') return jsonResp(await strengthenLink(context.env, body));
    if (action === 'block') {
      return jsonResp(await saveLink(context.env, {
        ...body,
        assoc_kind: BLOCK_KIND,
        status: body.status || 'active',
      }));
    }
    if (action === 'list') return jsonResp(await listLinks(context.env, body));
    return jsonResp({ error: 'unknown action: ' + action }, 400);
  } catch (err) {
    return jsonResp({ error: err.message || 'assoc-links error' }, 500);
  }
}
