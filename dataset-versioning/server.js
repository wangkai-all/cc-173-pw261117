// HTTP 服务：静态页面 + JSON API
// 关键约束：
//  - 版本不可变，发布后旧版本永远可查
//  - 所有发布做乐观并发校验：目标分支 head 被别人推进 → 409，必须重新核对
//  - 草稿与合并会话全部落库，刷新/重启不丢
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, seedIfEmpty, now, uid } from './db.js';
import { nearestCommonAncestor, threeWayMerge, materialize } from './merge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 8080;

seedIfEmpty();

// ---------------- 数据访问 ----------------
const Q = {
  dataset: db.prepare('SELECT * FROM datasets LIMIT 1'),
  versions: db.prepare('SELECT * FROM versions WHERE dataset_id=? ORDER BY num DESC'),
  version: db.prepare('SELECT * FROM versions WHERE id=?'),
  versionRows: db.prepare('SELECT pk, data FROM version_rows WHERE version_id=?'),
  branches: db.prepare('SELECT * FROM branches WHERE dataset_id=? ORDER BY created_at'),
  branch: db.prepare('SELECT * FROM branches WHERE id=?'),
  branchByName: db.prepare('SELECT * FROM branches WHERE dataset_id=? AND name=?'),
  drafts: db.prepare('SELECT * FROM drafts WHERE branch_id=?'),
  draft: db.prepare('SELECT * FROM drafts WHERE branch_id=? AND pk=?'),
  openMergeForPair: db.prepare(`SELECT * FROM merge_sessions WHERE status='open' AND source_branch_id=? AND target_branch_id=?`),
  openMerges: db.prepare(`SELECT * FROM merge_sessions WHERE status='open' AND (source_branch_id=? OR target_branch_id=?)`),
  merge: db.prepare('SELECT * FROM merge_sessions WHERE id=?'),
};

const J = JSON.parse;
const rowsOf = (versionId) => {
  const m = new Map();
  for (const r of Q.versionRows.all(versionId)) m.set(r.pk, J(r.data));
  return m;
};
const getDataset = () => { const d = Q.dataset.get(); return { ...d, fields: J(d.fields) }; };
const getBranch = (id) => { const b = Q.branch.get(id); if (!b) throw httpError(404, '分支不存在'); return b; };
const getVersion = (id) => { const v = Q.version.get(id); if (!v) throw httpError(404, '版本不存在'); return v; };

function httpError(status, message, extra = {}) {
  const e = new Error(message); e.status = status; e.extra = extra; return e;
}

// 分支工作区状态 = head 版本 + 草稿覆盖
function workingState(branch) {
  const rows = rowsOf(branch.head_version_id);
  const drafts = Q.drafts.all(branch.id).map(d => ({ ...d, data: d.data ? J(d.data) : null }));
  for (const d of drafts) {
    if (d.op === 'delete') rows.delete(d.pk);
    else rows.set(d.pk, d.data);
  }
  return { rows, drafts };
}

// 工作区行标注：clean / inserted / modified / deleted
function workspaceView(branch) {
  const headRows = rowsOf(branch.head_version_id);
  const drafts = Q.drafts.all(branch.id).map(d => ({ ...d, data: d.data ? J(d.data) : null }));
  const draftMap = new Map(drafts.map(d => [d.pk, d]));
  const dataset = getDataset();
  const fieldNames = dataset.fields.map(f => f.name);

  const rows = [];
  for (const [pk, rec] of headRows) {
    const d = draftMap.get(pk);
    if (!d) { rows.push({ pk, state: 'clean', record: rec }); continue; }
    if (d.op === 'delete') rows.push({ pk, state: 'deleted', record: rec });
    else {
      const changed = fieldNames.filter(f => JSON.stringify(rec[f]) !== JSON.stringify(d.data[f]));
      if (changed.length === 0) { // 改回原值 → 草稿自动清理
        db.prepare('DELETE FROM drafts WHERE branch_id=? AND pk=?').run(branch.id, pk);
        rows.push({ pk, state: 'clean', record: rec });
      } else rows.push({ pk, state: 'modified', record: d.data, base: rec, changed });
    }
    draftMap.delete(pk);
  }
  for (const [pk, d] of draftMap) { // 剩余的草稿：基线版本中不存在该主键
    if (d.op === 'insert') rows.push({ pk, state: 'inserted', record: d.data });
    else if (d.op === 'update') rows.push({ pk, state: 'stale', record: d.data }); // 基线行已被新 head 删除
    else db.prepare('DELETE FROM drafts WHERE branch_id=? AND pk=?').run(branch.id, pk); // 删除目标已消失，草稿自动清理
  }
  const order = (r) => String(r.pk);
  rows.sort((a, b) => order(a).localeCompare(order(b)));
  return { rows, drafts: Q.drafts.all(branch.id).map(d => ({ pk: d.pk, op: d.op, data: d.data ? J(d.data) : null, updated_at: d.updated_at })) };
}

// ---------------- 合并会话计算 ----------------
function computeMerge(session) {
  const source = getBranch(session.source_branch_id);
  const target = getBranch(session.target_branch_id);
  const dataset = getDataset();
  const fieldNames = dataset.fields.map(f => f.name);

  const parentsOf = (vid) => J(getVersion(vid).parents);
  const baseId = nearestCommonAncestor(source.head_version_id, target.head_version_id, parentsOf);
  if (!baseId) throw httpError(400, '两个分支没有共同祖先，无法三方合并');

  const baseRows = rowsOf(baseId);
  const ours = workingState(target);
  const theirs = workingState(source);
  const result = threeWayMerge(baseRows, ours.rows, theirs.rows, fieldNames);

  // 保留仍然适用的解决方案
  const oldRes = J(session.resolutions || '{}');
  const res = {};
  for (const c of result.conflicts) {
    const old = oldRes[c.pk];
    if (!old) continue;
    if (c.type === 'delete-modify') {
      if (old.row === 'keep' || old.row === 'delete') res[c.pk] = { row: old.row };
    } else {
      const fields = {};
      for (const fc of c.fields) {
        const of = old.fields?.[fc.field];
        if (of && (of.choice === 'ours' || of.choice === 'theirs' || (of.choice === 'custom' && of.value !== undefined))) {
          fields[fc.field] = of;
        }
      }
      if (Object.keys(fields).length) res[c.pk] = { fields };
    }
  }

  return {
    base_version_id: baseId,
    source_version_id: source.head_version_id,
    target_version_id: target.head_version_id,
    source_has_draft: theirs.drafts.length ? 1 : 0,
    target_has_draft: ours.drafts.length ? 1 : 0,
    result: JSON.stringify(result),
    resolutions: JSON.stringify(res),
  };
}

function saveMergeComputation(sessionId, comp) {
  db.prepare(`UPDATE merge_sessions SET base_version_id=?, source_version_id=?, target_version_id=?,
    source_has_draft=?, target_has_draft=?, result=?, resolutions=?, updated_at=? WHERE id=?`)
    .run(comp.base_version_id, comp.source_version_id, comp.target_version_id,
      comp.source_has_draft, comp.target_has_draft, comp.result, comp.resolutions, now(), sessionId);
}

function mergeView(session) {
  const dataset = getDataset();
  const src = Q.branch.get(session.source_branch_id);
  const tgt = Q.branch.get(session.target_branch_id);
  const result = J(session.result);
  const resolutions = J(session.resolutions);
  const unresolvedCount = countUnresolved(result, resolutions);
  const vNum = (id) => Q.version.get(id)?.num;
  return {
    id: session.id, status: session.status, needs_review: !!session.needs_review,
    source_branch: { id: src.id, name: src.name }, target_branch: { id: tgt.id, name: tgt.name },
    base_version_num: vNum(session.base_version_id),
    source_version_num: vNum(session.source_version_id),
    target_version_num: vNum(session.target_version_id),
    source_has_draft: !!session.source_has_draft, target_has_draft: !!session.target_has_draft,
    result, resolutions, unresolved_count: unresolvedCount,
    created_at: session.created_at, updated_at: session.updated_at,
    fields: dataset.fields,
  };
}

function countUnresolved(result, resolutions) {
  let n = 0;
  for (const c of result.conflicts) {
    const r = resolutions[c.pk];
    if (c.type === 'delete-modify') { if (!r?.row) n++; }
    else {
      for (const fc of c.fields) {
        const fr = r?.fields?.[fc.field];
        if (!fr || !(fr.choice === 'ours' || fr.choice === 'theirs' || (fr.choice === 'custom' && fr.value !== undefined))) n++;
      }
    }
  }
  return n;
}

// ---------------- 发布 ----------------
function publishVersion({ datasetId, branchId, parents, kind, message, stats, finalRows }) {
  const versionId = uid();
  const num = db.prepare('SELECT COALESCE(MAX(num),0)+1 AS n FROM versions WHERE dataset_id=?').get(datasetId).n;
  db.prepare('INSERT INTO versions (id,dataset_id,num,parents,branch_id,kind,message,stats,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(versionId, datasetId, num, JSON.stringify(parents), branchId, kind, message || null, JSON.stringify(stats), now());
  const ins = db.prepare('INSERT INTO version_rows (version_id,pk,data) VALUES (?,?,?)');
  for (const [pk, rec] of finalRows) ins.run(versionId, pk, JSON.stringify(rec));
  return Q.version.get(versionId);
}

const api = {};

// 总览：数据集 + 分支 + 版本
api['GET /api/state'] = () => {
  const dataset = getDataset();
  const branches = Q.branches.all(dataset.id).map(b => {
    const head = Q.version.get(b.head_version_id);
    const draftCount = db.prepare('SELECT COUNT(*) c FROM drafts WHERE branch_id=?').get(b.id).c;
    const merges = Q.openMerges.all(b.id).map(m => ({
      id: m.id,
      direction: m.target_branch_id === b.id ? 'incoming' : 'outgoing',
      other_branch: Q.branch.get(m.target_branch_id === b.id ? m.source_branch_id : m.target_branch_id)?.name,
      needs_review: !!m.needs_review,
      unresolved: countUnresolved(J(m.result), J(m.resolutions)),
    }));
    return { ...b, head_num: head?.num, draft_count: draftCount, open_merges: merges };
  });
  const versions = Q.versions.all(dataset.id).map(v => ({
    ...v, parents: J(v.parents), stats: v.stats ? J(v.stats) : null,
    branch_name: v.branch_id ? Q.branch.get(v.branch_id)?.name : null,
    parent_nums: J(v.parents).map(p => Q.version.get(p)?.num),
  }));
  return { dataset, branches, versions };
};

api['GET /api/versions/:id'] = (p) => {
  const v = getVersion(p.id);
  const rows = [...rowsOf(v.id).values()];
  return { version: { ...v, parents: J(v.parents), stats: v.stats ? J(v.stats) : null, branch_name: v.branch_id ? Q.branch.get(v.branch_id)?.name : null }, rows };
};

api['POST /api/branches'] = (p, body) => {
  const dataset = getDataset();
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, '分支名不能为空');
  if (Q.branchByName.get(dataset.id, name)) throw httpError(409, `分支 "${name}" 已存在`);
  const from = getVersion(body.from_version_id);
  const id = uid();
  db.prepare('INSERT INTO branches (id,dataset_id,name,created_from_version_id,head_version_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, dataset.id, name, from.id, from.id, now());
  return { branch: Q.branch.get(id) };
};

api['GET /api/branches/:id/workspace'] = (p) => {
  const branch = getBranch(p.id);
  const head = Q.version.get(branch.head_version_id);
  const { rows, drafts } = workspaceView(branch);
  const merges = Q.openMerges.all(branch.id).map(m => ({ id: m.id, needs_review: !!m.needs_review }));
  return {
    branch: { ...branch, head_num: head.num },
    head_version: { id: head.id, num: head.num, message: head.message, created_at: head.created_at },
    rows, drafts, open_merges: merges, fields: getDataset().fields,
  };
};

// 草稿编辑：insert / update / delete
api['PUT /api/branches/:id/draft/:pk'] = (p, body) => {
  const branch = getBranch(p.id);
  const pk = decodeURIComponent(p.pk);
  const { op, data } = body;
  const dataset = getDataset();
  const pkField = dataset.pk_field;
  const headRows = rowsOf(branch.head_version_id);
  const existing = Q.draft.get(branch.id, pk);

  if (op === 'insert') {
    if (!data || data[pkField] === undefined || String(data[pkField]).trim() === '') throw httpError(400, `主键 ${pkField} 不能为空`);
    const newPk = String(data[pkField]);
    if (newPk !== pk) throw httpError(400, '主键不可修改；如需换主键请删除后重新新增');
    if (headRows.has(pk) && !(existing && existing.op === 'insert')) throw httpError(409, `主键 ${pk} 已存在`);
    if (existing && existing.op !== 'insert') throw httpError(409, `主键 ${pk} 已存在`);
    upsertDraft(branch.id, pk, 'insert', data);
  } else if (op === 'update') {
    if (!headRows.has(pk) && !(existing && existing.op === 'insert')) throw httpError(404, `记录 ${pk} 不存在`);
    if (existing && existing.op === 'delete') throw httpError(409, `记录 ${pk} 已被标记删除，请先还原`);
    if (existing && existing.op === 'insert') {
      upsertDraft(branch.id, pk, 'insert', data); // 新增后再改，仍是新增
    } else {
      const head = headRows.get(pk);
      const same = dataset.fields.every(f => JSON.stringify(head[f.name]) === JSON.stringify(data[f.name]));
      if (same) db.prepare('DELETE FROM drafts WHERE branch_id=? AND pk=?').run(branch.id, pk); // 改回原值
      else upsertDraft(branch.id, pk, 'update', data);
    }
  } else if (op === 'delete') {
    if (existing && existing.op === 'insert') {
      db.prepare('DELETE FROM drafts WHERE branch_id=? AND pk=?').run(branch.id, pk); // 未发布的新增直接撤掉
    } else if (headRows.has(pk)) {
      upsertDraft(branch.id, pk, 'delete', null);
    } else throw httpError(404, `记录 ${pk} 不存在`);
  } else throw httpError(400, '未知操作');
  return { ok: true, drafts: Q.drafts.all(branch.id).length };
};

function upsertDraft(branchId, pk, op, data) {
  db.prepare(`INSERT INTO drafts (branch_id,pk,op,data,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(branch_id,pk) DO UPDATE SET op=excluded.op, data=excluded.data, updated_at=excluded.updated_at`)
    .run(branchId, pk, op, data ? JSON.stringify(data) : null, now());
}

api['DELETE /api/branches/:id/draft/:pk'] = (p) => {
  const branch = getBranch(p.id);
  db.prepare('DELETE FROM drafts WHERE branch_id=? AND pk=?').run(branch.id, decodeURIComponent(p.pk));
  return { ok: true };
};

api['DELETE /api/branches/:id/draft'] = (p) => {
  const branch = getBranch(p.id);
  db.prepare('DELETE FROM drafts WHERE branch_id=?').run(branch.id);
  return { ok: true };
};

// 发布草稿为新版本（乐观并发：expected_head 必须等于当前 head）
api['POST /api/branches/:id/publish'] = (p, body) => {
  const branch = getBranch(p.id);
  if (body.expected_head !== branch.head_version_id) {
    const head = Q.version.get(branch.head_version_id);
    throw httpError(409, '分支已有新版本发布，请重新核对你的修改', { current_head_num: head.num });
  }
  const drafts = Q.drafts.all(branch.id).map(d => ({ ...d, data: d.data ? J(d.data) : null }));
  if (!drafts.length) throw httpError(400, '没有可发布的修改');

  const headRows = rowsOf(branch.head_version_id);
  let added = 0, modified = 0, deleted = 0;
  const finalRows = new Map(headRows);
  for (const d of drafts) {
    if (d.op === 'insert') {
      if (headRows.has(d.pk)) throw httpError(409, `主键 ${d.pk} 与已发布数据冲突，请先处理`);
      finalRows.set(d.pk, d.data); added++;
    } else if (d.op === 'update') {
      if (!headRows.has(d.pk)) throw httpError(409, `记录 ${d.pk} 在新版本中已不存在，请先处理该草稿`);
      finalRows.set(d.pk, d.data); modified++;
    } else { finalRows.delete(d.pk); deleted++; }
  }

  db.exec('BEGIN');
  try {
    const v = publishVersion({
      datasetId: branch.dataset_id, branchId: branch.id, parents: [branch.head_version_id],
      kind: 'commit', message: body.message || '发布修改',
      stats: { added, modified, deleted, auto: 0, conflicts: 0 }, finalRows,
    });
    db.prepare('UPDATE branches SET head_version_id=? WHERE id=?').run(v.id, branch.id);
    db.prepare('DELETE FROM drafts WHERE branch_id=?').run(branch.id);
    db.exec('COMMIT');
    return { version: { ...v, parents: J(v.parents) } };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
};

// 创建（或恢复）合并会话
api['POST /api/merges'] = (p, body) => {
  const source = getBranch(body.source_branch_id);
  const target = getBranch(body.target_branch_id);
  if (source.id === target.id) throw httpError(400, '源分支与目标分支不能相同');
  let session = Q.openMergeForPair.get(source.id, target.id);
  if (!session) {
    const id = uid();
    db.prepare(`INSERT INTO merge_sessions (id,dataset_id,source_branch_id,target_branch_id,base_version_id,source_version_id,target_version_id,result,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, source.dataset_id, source.id, target.id, source.head_version_id, source.head_version_id, target.head_version_id, '{"added":[],"deleted":[],"auto":[],"conflicts":[]}', now(), now());
    session = Q.merge.get(id);
  }
  const comp = computeMerge(session);
  saveMergeComputation(session.id, comp);
  return { session: mergeView(Q.merge.get(session.id)) };
};

api['GET /api/merges/:id'] = (p) => {
  const session = Q.merge.get(p.id);
  if (!session) throw httpError(404, '合并会话不存在');
  return { session: mergeView(session) };
};

// 保存冲突解决进度（同时视为一次"核对"，清除 needs_review）
api['PUT /api/merges/:id/resolutions'] = (p, body) => {
  const session = Q.merge.get(p.id);
  if (!session || session.status !== 'open') throw httpError(404, '合并会话不存在或已关闭');
  db.prepare('UPDATE merge_sessions SET resolutions=?, needs_review=0, updated_at=? WHERE id=?')
    .run(JSON.stringify(body.resolutions || {}), now(), session.id);
  return { session: mergeView(Q.merge.get(session.id)) };
};

// 重新核对：按当前分支状态重算预览
api['POST /api/merges/:id/recheck'] = (p) => {
  const session = Q.merge.get(p.id);
  if (!session || session.status !== 'open') throw httpError(404, '合并会话不存在或已关闭');
  const comp = computeMerge(session);
  saveMergeComputation(session.id, comp);
  db.prepare('UPDATE merge_sessions SET needs_review=0 WHERE id=?').run(session.id);
  return { session: mergeView(Q.merge.get(session.id)) };
};

api['POST /api/merges/:id/cancel'] = (p) => {
  const session = Q.merge.get(p.id);
  if (!session || session.status !== 'open') throw httpError(404, '合并会话不存在或已关闭');
  db.prepare(`UPDATE merge_sessions SET status='cancelled', updated_at=? WHERE id=?`).run(now(), session.id);
  return { ok: true };
};

// 发布合并：校验目标分支 head 未被别人推进
api['POST /api/merges/:id/publish'] = (p, body) => {
  const session = Q.merge.get(p.id);
  if (!session || session.status !== 'open') throw httpError(404, '合并会话不存在或已关闭');
  const target = getBranch(session.target_branch_id);
  const source = getBranch(session.source_branch_id);

  const staleTarget = session.target_version_id !== target.head_version_id;
  const staleSource = session.source_version_id !== source.head_version_id;
  if (staleTarget || staleSource) {
    // 目标（或源）分支已被别人推进：重算预览并要求重新核对，绝不悄悄覆盖
    const comp = computeMerge(session);
    saveMergeComputation(session.id, comp);
    db.prepare('UPDATE merge_sessions SET needs_review=1 WHERE id=?').run(session.id);
    const head = Q.version.get(target.head_version_id);
    throw httpError(409,
      staleTarget ? `目标分支已推进到 v${head.num}，合并预览已重算，请重新核对后再发布` : '源分支已有新版本，合并预览已重算，请重新核对后再发布',
      { session: mergeView(Q.merge.get(session.id)) });
  }
  if (session.needs_review) throw httpError(409, '合并预览已变化，请先保存核对结果再发布', { session: mergeView(session) });

  const result = J(session.result);
  const resolutions = J(session.resolutions);
  const ours = workingState(target);
  const { finalRows, unresolved } = materialize(result, resolutions, ours.rows);
  if (unresolved.length) throw httpError(400, `还有 ${unresolved.length} 处冲突未解决`, { unresolved });

  db.exec('BEGIN');
  try {
    const v = publishVersion({
      datasetId: session.dataset_id, branchId: target.id,
      parents: [target.head_version_id, source.head_version_id],
      kind: 'merge', message: body.message || `合并 ${source.name} → ${target.name}`,
      stats: { added: result.added.length, deleted: result.deleted.length, auto: result.auto.length, conflicts: result.conflicts.length, modified: 0 },
      finalRows,
    });
    db.prepare('UPDATE branches SET head_version_id=? WHERE id=?').run(v.id, target.id);
    db.prepare('DELETE FROM drafts WHERE branch_id=?').run(target.id); // 目标分支草稿已并入新版本
    db.prepare(`UPDATE merge_sessions SET status='published', updated_at=? WHERE id=?`).run(now(), session.id);
    db.exec('COMMIT');
    return { version: { ...v, parents: J(v.parents) } };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
};

// ---------------- 路由 ----------------
const routes = Object.entries(api).map(([key, fn]) => {
  const [method, pattern] = key.split(' ');
  const parts = pattern.split('/');
  return { method, parts, fn };
});

function matchRoute(method, pathname) {
  const segs = pathname.split('/');
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = segs[i];
      else if (r.parts[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return { fn: r.fn, params };
  }
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const m = matchRoute(req.method, url.pathname);
      if (!m) throw httpError(404, '接口不存在');
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw) body = JSON.parse(raw);
      }
      const out = m.fn(m.params, body) || {};
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
      return;
    }
    // 静态文件
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(PUBLIC, path);
    if (!file.startsWith(PUBLIC)) throw httpError(403, 'forbidden');
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message, ...(e.extra || {}) }));
  }
});

server.listen(PORT, () => console.log(`数据集版本管理工具: http://localhost:${PORT}`));
