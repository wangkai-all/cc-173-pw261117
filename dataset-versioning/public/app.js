/* 数据集版本管理 —— 前端单页应用 */
'use strict';

// ---------------- 基础工具 ----------------
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-';
const fmtVal = (v) => v === null || v === undefined ? '∅' : String(v);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `请求失败 (${res.status})`);
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}

function toast(msg, type = 'ok', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function openModal(html, { wide } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-mask"><div class="modal${wide ? ' wide' : ''}">${html}</div></div>`;
  const close = () => { root.innerHTML = ''; };
  $('.modal-mask', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-mask')) close(); });
  $$('.modal-close', root).forEach(b => b.addEventListener('click', close));
  return close;
}
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let DATASET = null;   // {id, name, pk_field, fields:[{name,label,type}]}
const fieldLabel = (name) => DATASET?.fields.find(f => f.name === name)?.label || name;
const fieldType = (name) => DATASET?.fields.find(f => f.name === name)?.type || 'text';

// ---------------- 路由 ----------------
window.addEventListener('hashchange', render);
async function render() {
  const hash = location.hash || '#/branches';
  const parts = hash.slice(2).split('/');
  const navMap = { branch: 'branches', merge: 'branches', branches: 'branches', version: 'versions', versions: 'versions' };
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === navMap[parts[0]]));
  try {
    if (parts[0] === 'branch' && parts[1]) await viewWorkspace(parts[1]);
    else if (parts[0] === 'merge' && parts[1]) await viewMerge(parts[1]);
    else if (parts[0] === 'versions') await viewVersions();
    else if (parts[0] === 'version' && parts[1]) await viewVersion(parts[1]);
    else await viewBranches();
  } catch (e) {
    app.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

async function ensureState() {
  const s = await api('GET', '/api/state');
  DATASET = s.dataset;
  $('#dataset-name').textContent = s.dataset.name;
  return s;
}

// ---------------- 视图：分支列表 ----------------
async function viewBranches() {
  const s = await ensureState();
  app.innerHTML = `
    <div class="page-head">
      <div><h1>分支</h1><div class="sub">从任意版本开出分支，各自编辑后再做三方合并；版本不可变，旧版本永远可查。</div></div>
      <button class="btn primary" id="btn-new-branch">+ 新建分支</button>
    </div>
    <div class="branch-grid">
      ${s.branches.map(b => `
        <div class="card branch-card">
          <div class="name-row">
            <span class="name">${esc(b.name)}</span>
            <span class="badge blue mono">v${b.head_num}</span>
            ${b.draft_count ? `<span class="badge amber">${b.draft_count} 处未发布修改</span>` : ''}
          </div>
          <div class="meta">
            <span>创建于 ${fmtTime(b.created_at)}</span>
            ${b.open_merges.map(m => `
              <a class="merge-chip ${m.needs_review ? 'review' : ''}" href="#/merge/${m.id}">
                ⇄ 合并${m.direction === 'incoming' ? '自' : '到'} ${esc(m.other_branch)}
                ${m.unresolved ? `· ${m.unresolved} 处冲突待解决` : '· 无未解决冲突'}
                ${m.needs_review ? '· 需重新核对' : ''}
              </a>`).join('')}
          </div>
          <div class="actions">
            <a class="btn small primary" href="#/branch/${b.id}">进入工作区</a>
          </div>
        </div>`).join('')}
    </div>`;
  $('#btn-new-branch').addEventListener('click', () => openNewBranchModal(s.versions));
}

function openNewBranchModal(versions) {
  const close = openModal(`
    <div class="modal-head"><h2>新建分支</h2><button class="modal-close">✕</button></div>
    <div class="modal-body">
      <div class="form-row"><label>分支名</label><input id="nb-name" placeholder="例如 feature-调价"></div>
      <div class="form-row"><label>基于版本</label><select id="nb-version">
        ${versions.map(v => `<option value="${v.id}">v${v.num} · ${esc(v.message || '')}（${fmtTime(v.created_at)}）</option>`).join('')}
      </select></div>
    </div>
    <div class="modal-foot">
      <button class="btn modal-close">取消</button>
      <button class="btn primary" id="nb-ok">创建</button>
    </div>`);
  $('#nb-ok').addEventListener('click', async () => {
    const name = $('#nb-name').value.trim();
    const from_version_id = $('#nb-version').value;
    try {
      const r = await api('POST', '/api/branches', { name, from_version_id });
      close(); toast(`分支 "${name}" 已创建`);
      location.hash = `#/branch/${r.branch.id}`;
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ---------------- 视图：分支工作区 ----------------
async function viewWorkspace(branchId) {
  const ws = await api('GET', `/api/branches/${branchId}/workspace`);
  await ensureState();
  const b = ws.branch;
  const draftCount = ws.drafts.length;
  const stateBadge = { clean: '', inserted: '<span class="badge green">新增</span>', modified: '<span class="badge amber">已修改</span>', deleted: '<span class="badge red">待删除</span>', stale: '<span class="badge red">基线已删除</span>' };

  app.innerHTML = `
    <div class="ws-head">
      <div>
        <div class="ws-title">
          <span class="branch-name">${esc(b.name)}</span>
          <span class="badge blue mono">head: v${b.head_num}</span>
          ${draftCount ? `<span class="badge amber">${draftCount} 处未发布修改</span>` : '<span class="badge gray">工作区干净</span>'}
        </div>
        <div class="ws-meta">基于版本 v${b.head_num} · ${esc(ws.head_version.message || '')} · ${fmtTime(ws.head_version.created_at)}</div>
      </div>
      <div class="ws-actions">
        <button class="btn" id="ws-add">+ 新增记录</button>
        <button class="btn" id="ws-merge">⇄ 合并分支…</button>
        ${draftCount ? `<button class="btn danger" id="ws-discard">放弃全部修改</button>
        <button class="btn primary" id="ws-publish">发布版本（${draftCount}）</button>` : ''}
      </div>
    </div>
    ${ws.open_merges.map(m => `
      <div class="banner ${m.needs_review ? 'red' : 'amber'}">
        <span>该分支有进行中的合并${m.needs_review ? '，目标分支已更新，<b>需要重新核对</b>' : ''}。</span>
        <a class="btn small" href="#/merge/${m.id}">继续处理合并 →</a>
      </div>`).join('')}
    ${draftCount ? `
    <div class="banner blue draft-bar">
      <span>未发布的修改：${ws.drafts.map(d => `<span class="badge ${d.op === 'insert' ? 'green' : d.op === 'delete' ? 'red' : 'amber'} mono">${esc(d.pk)} ${d.op === 'insert' ? '新增' : d.op === 'delete' ? '删除' : '修改'}</span>`).join('')}</span>
    </div>` : ''}
    <div class="card table-wrap">
      <table class="data">
        <thead><tr>
          ${DATASET.fields.map(f => `<th class="${f.type === 'number' ? 'num' : ''}">${esc(f.label)}</th>`).join('')}
          <th>状态</th><th>操作</th>
        </tr></thead>
        <tbody>
          ${ws.rows.map(r => `
            <tr class="row-${r.state}">
              ${DATASET.fields.map(f => `
                <td class="${f.type === 'number' ? 'num' : ''} ${r.state === 'modified' && r.changed.includes(f.name) ? 'cell-changed' : ''}">
                  <span class="cell-val">${esc(fmtVal(r.record[f.name]))}</span>
                </td>`).join('')}
              <td>${stateBadge[r.state]}</td>
              <td><div class="row-actions">
                ${['clean', 'inserted', 'modified'].includes(r.state) ? `<button class="btn small" data-act="edit" data-pk="${esc(r.pk)}">编辑</button>
                <button class="btn small danger" data-act="del" data-pk="${esc(r.pk)}">删除</button>` : ''}
                ${r.state !== 'clean' ? `<button class="btn small" data-act="revert" data-pk="${esc(r.pk)}">还原</button>` : ''}
              </div></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="legend" style="margin-top:10px">
      <span><i class="dot" style="background:var(--green-bg);border:1px solid var(--green)"></i>新增（未发布）</span>
      <span><i class="dot" style="background:var(--amber-bg);border:1px solid var(--amber)"></i>修改的字段</span>
      <span><i class="dot" style="background:var(--red-bg);border:1px solid var(--red)"></i>待删除</span>
      <span>所有修改先存为草稿，刷新/重启不丢失，发布后形成不可变新版本。</span>
    </p>`;

  // ---- 事件 ----
  $('#ws-add').addEventListener('click', () => openEditModal(b, null));
  $('#ws-merge').addEventListener('click', () => openMergeSetupModal(b));
  $('#ws-discard')?.addEventListener('click', async () => {
    if (!confirm(`确定放弃分支 "${b.name}" 上全部 ${draftCount} 处未发布修改？`)) return;
    await api('DELETE', `/api/branches/${b.id}/draft`);
    toast('已放弃全部未发布修改'); render();
  });
  $('#ws-publish')?.addEventListener('click', () => openPublishModal(b, ws));
  $$('[data-act]', app).forEach(btn => btn.addEventListener('click', async () => {
    const pk = btn.dataset.pk;
    const act = btn.dataset.act;
    if (act === 'edit') {
      const row = ws.rows.find(r => r.pk === pk);
      openEditModal(b, row);
    } else if (act === 'del') {
      await api('PUT', `/api/branches/${b.id}/draft/${encodeURIComponent(pk)}`, { op: 'delete' });
      toast(`已标记删除 ${pk}`); render();
    } else if (act === 'revert') {
      await api('DELETE', `/api/branches/${b.id}/draft/${encodeURIComponent(pk)}`);
      toast(`已还原 ${pk}`); render();
    }
  }));
}

// 新增 / 编辑记录弹窗
function openEditModal(branch, row) {
  const isNew = !row;
  const rec = row?.record || {};
  const close = openModal(`
    <div class="modal-head"><h2>${isNew ? '新增记录' : `编辑记录 ${esc(row.pk)}`}</h2><button class="modal-close">✕</button></div>
    <div class="modal-body">
      ${DATASET.fields.map(f => `
        <div class="form-row">
          <label>${esc(f.label)}</label>
          <input data-field="${f.name}" type="${f.type === 'number' ? 'number' : 'text'}" step="any"
            value="${esc(rec[f.name] ?? '')}" ${f.name === DATASET.pk_field && !isNew ? 'disabled' : ''}>
        </div>`).join('')}
    </div>
    <div class="modal-foot">
      <button class="btn modal-close">取消</button>
      <button class="btn primary" id="edit-ok">保存到草稿</button>
    </div>`);
  $('#edit-ok').addEventListener('click', async () => {
    const data = {};
    for (const f of DATASET.fields) {
      const raw = $(`[data-field="${f.name}"]`).value.trim();
      data[f.name] = f.type === 'number' ? (raw === '' ? null : Number(raw)) : raw;
    }
    const pk = String(data[DATASET.pk_field]);
    try {
      await api('PUT', `/api/branches/${branch.id}/draft/${encodeURIComponent(pk)}`, { op: isNew ? 'insert' : 'update', data });
      close(); toast(isNew ? `已新增 ${pk}（草稿）` : `已保存 ${pk} 的修改（草稿）`);
      render();
    } catch (e) { toast(e.message, 'err'); }
  });
}

// 发布版本弹窗（展示本次修改清单）
function openPublishModal(branch, ws) {
  const drafts = ws.drafts;
  const cnt = { insert: 0, update: 0, delete: 0 };
  drafts.forEach(d => cnt[d.op]++);
  const close = openModal(`
    <div class="modal-head"><h2>发布新版本 · ${esc(branch.name)}</h2><button class="modal-close">✕</button></div>
    <div class="modal-body">
      <p style="margin-top:0">基于 <b class="mono">v${branch.head_num}</b> 发布以下修改，发布后形成不可变新版本：</p>
      <p>
        <span class="badge green">新增 ${cnt.insert}</span>
        <span class="badge amber">修改 ${cnt.update}</span>
        <span class="badge red">删除 ${cnt.delete}</span>
      </p>
      <table class="diff"><thead><tr><th>主键</th><th>操作</th></tr></thead><tbody>
        ${drafts.map(d => `<tr><td class="mono">${esc(d.pk)}</td><td>${d.op === 'insert' ? '<span class="badge green">新增</span>' : d.op === 'delete' ? '<span class="badge red">删除</span>' : '<span class="badge amber">修改</span>'}</td></tr>`).join('')}
      </tbody></table>
      <div class="form-row" style="margin-top:14px"><label>提交信息</label><input id="pub-msg" placeholder="例如：更新订单状态"></div>
    </div>
    <div class="modal-foot">
      <button class="btn modal-close">取消</button>
      <button class="btn primary" id="pub-ok">确认发布</button>
    </div>`);
  $('#pub-ok').addEventListener('click', async () => {
    try {
      const r = await api('POST', `/api/branches/${branch.id}/publish`, {
        expected_head: branch.head_version_id,
        message: $('#pub-msg').value.trim() || undefined,
      });
      close(); toast(`已发布 v${r.version.num}`, 'ok');
      render();
    } catch (e) {
      close();
      if (e.status === 409) {
        toast(`${e.message}（当前已是 v${e.data?.current_head_num}），工作区已刷新`, 'err', 5000);
        render(); // 重新加载：草稿自动基于新 head 重新比对
      } else toast(e.message, 'err');
    }
  });
}

// 发起合并弹窗
async function openMergeSetupModal(currentBranch) {
  const s = await api('GET', '/api/state');
  const others = s.branches.filter(x => x.id !== currentBranch.id);
  if (!others.length) { toast('没有其他分支可合并，请先新建分支', 'err'); return; }
  const close = openModal(`
    <div class="modal-head"><h2>合并分支</h2><button class="modal-close">✕</button></div>
    <div class="modal-body">
      <p style="margin-top:0;color:var(--text-2)">选择源分支合并到目标分支。系统将找到共同祖先版本做<b>字段级</b>三方合并：仅一边改动的字段直接合入；两边改同一字段为不同值、删除与修改冲突的，逐项人工处理。</p>
      <div class="form-row"><label>源分支</label><select id="mg-src">
        ${s.branches.map((x, i) => `<option value="${x.id}" ${x.id === currentBranch.id ? 'disabled' : s.branches.find(y => y.id !== currentBranch.id)?.id === x.id ? 'selected' : ''}>将 ${esc(x.name)}（v${x.head_num}${x.draft_count ? ` + ${x.draft_count} 草稿` : ''}）</option>`).join('')}
      </select></div>
      <div class="form-row"><label>目标分支</label><select id="mg-tgt">
        ${s.branches.map(x => `<option value="${x.id}" ${x.id === currentBranch.id ? 'selected' : ''}>合并到 ${esc(x.name)}（v${x.head_num}${x.draft_count ? ` + ${x.draft_count} 草稿` : ''}）</option>`).join('')}
      </select></div>
    </div>
    <div class="modal-foot">
      <button class="btn modal-close">取消</button>
      <button class="btn primary" id="mg-ok">计算合并预览</button>
    </div>`);
  $('#mg-ok').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/merges', { source_branch_id: $('#mg-src').value, target_branch_id: $('#mg-tgt').value });
      close();
      location.hash = `#/merge/${r.session.id}`;
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ---------------- 视图：合并预览与冲突解决 ----------------
let mergeState = null;       // 当前合并会话
let saveTimer = null;

async function viewMerge(mergeId) {
  const { session } = await api('GET', `/api/merges/${mergeId}`);
  await ensureState();
  mergeState = session;
  if (session.status !== 'open') {
    app.innerHTML = `<div class="empty">该合并会话已${session.status === 'published' ? '发布' : '取消'}。<a href="#/branches">返回分支列表</a></div>`;
    return;
  }
  renderMerge();
}

function renderMerge() {
  const s = mergeState;
  const r = s.result;
  const unresolved = s.unresolved_count;

  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>合并 <span class="mono">${esc(s.source_branch.name)}</span> → <span class="mono">${esc(s.target_branch.name)}</span></h1>
        <div class="sub">共同祖先 <b class="mono">v${s.base_version_num}</b> · 源 v${s.source_version_num}${s.source_has_draft ? '（含草稿）' : ''} · 目标 v${s.target_version_num}${s.target_has_draft ? '（含草稿）' : ''} · 字段级三方合并，不整行覆盖</div>
      </div>
      <a class="btn" href="#/branch/${s.target_branch.id}">← 返回 ${esc(s.target_branch.name)}</a>
    </div>
    ${s.needs_review ? `
      <div class="banner red">
        <span>⚠ 目标分支在你准备期间已被其他人推进，预览已按最新状态重算，<b>请重新核对</b>后再发布。</span>
        <button class="btn small" id="mg-reviewed">我已核对</button>
      </div>` : ''}
    <div class="stat-cards">
      <div class="card stat-card red"><span class="n">${r.conflicts.length}</span><span class="t">冲突记录（${unresolved} 处待解决）</span></div>
      <div class="card stat-card blue"><span class="n">${r.auto.length}</span><span class="t">自动合并</span></div>
      <div class="card stat-card green"><span class="n">${r.added.length}</span><span class="t">新增记录</span></div>
      <div class="card stat-card red"><span class="n">${r.deleted.length}</span><span class="t">删除记录</span></div>
    </div>

    ${r.conflicts.length ? `
    <div class="section">
      <div class="section-head"><h2>冲突 · 逐项处理</h2><span class="desc">两边把同一字段改成不同值，或一边删除一边修改时产生冲突，不会自动覆盖。</span></div>
      ${r.conflicts.map(c => conflictCard(c, s)).join('')}
    </div>` : ''}

    <div class="section">
      <div class="section-head"><h2>自动合并（${r.auto.length}）</h2><span class="desc">仅一边修改，或两边修改了不同字段 —— 按字段合入。</span></div>
      <div class="card table-wrap">${autoTable(r.auto, s)}</div>
    </div>
    <div class="section">
      <div class="section-head"><h2>新增（${r.added.length}）</h2></div>
      <div class="card table-wrap">${simpleTable(r.added.map(a => ({ pk: a.pk, record: a.record, tag: a.from === 'ours' ? `来自 ${s.target_branch.name}` : a.from === 'theirs' ? `来自 ${s.source_branch.name}` : '两边一致' })), s)}</div>
    </div>
    <div class="section">
      <div class="section-head"><h2>删除（${r.deleted.length}）</h2></div>
      <div class="card table-wrap">${simpleTable(r.deleted.map(d => ({ pk: d.pk, record: d.record, tag: d.by === 'ours' ? `由 ${s.target_branch.name} 删除` : d.by === 'theirs' ? `由 ${s.source_branch.name} 删除` : '两边都删除' })), s)}</div>
    </div>

    <div class="merge-bar">
      <div class="left">
        <button class="btn danger" id="mg-cancel">取消合并</button>
        <button class="btn" id="mg-recheck">↻ 重新核对（按最新分支状态重算）</button>
      </div>
      <div class="right">
        <span id="mg-unresolved" class="${unresolved ? 'badge red' : 'badge green'}">${unresolved ? `还有 ${unresolved} 处冲突未解决` : '冲突已全部解决'}</span>
        <input type="text" class="msg custom-input" id="mg-msg" placeholder="提交信息（可选）" style="width:220px">
        <button class="btn primary" id="mg-publish" ${unresolved || s.needs_review ? 'disabled' : ''}>发布合并</button>
      </div>
    </div>`;

  bindMergeEvents();
}

function conflictCard(c, s) {
  const res = s.resolutions[c.pk] || {};
  const oursName = s.target_branch.name, theirsName = s.source_branch.name;

  if (c.type === 'delete-modify') {
    const modName = c.modifiedBy === 'ours' ? oursName : theirsName;
    const delName = c.deletedBy === 'ours' ? oursName : theirsName;
    const resolved = res.row === 'keep' || res.row === 'delete';
    return `
    <div class="card conflict-card ${resolved ? 'resolved' : ''}" data-pk="${esc(c.pk)}">
      <div class="conflict-title">
        <span class="mono">${esc(c.pk)}</span>
        <span class="badge red">删除 / 修改冲突</span>
        ${resolved ? '<span class="badge green">已解决</span>' : ''}
      </div>
      <p style="margin:0 0 10px;color:var(--text-2)">
        <b>${esc(delName)}</b> 删除了该记录，而 <b>${esc(modName)}</b> 修改了它：
        ${DATASET.fields.map(f => {
          const bv = c.base[f.name], mv = c.modified[f.name];
          return JSON.stringify(bv) !== JSON.stringify(mv) ? `<span class="badge amber" style="margin-left:4px">${esc(f.label)}: ${esc(fmtVal(bv))} → ${esc(fmtVal(mv))}</span>` : '';
        }).join('')}
      </p>
      <div class="choice">
        <label><input type="radio" name="row-${esc(c.pk)}" value="keep" ${res.row === 'keep' ? 'checked' : ''}> 保留修改后的记录</label>
        <label><input type="radio" name="row-${esc(c.pk)}" value="delete" ${res.row === 'delete' ? 'checked' : ''}> 删除该记录</label>
      </div>
    </div>`;
  }

  // 字段冲突（含两边都新增同一主键）
  const allResolved = c.fields.every(fc => res.fields?.[fc.field]);
  const title = c.type === 'both-insert' ? '两边新增了同一主键，内容不同' : '同一字段被改成不同值';
  return `
  <div class="card conflict-card ${allResolved ? 'resolved' : ''}" data-pk="${esc(c.pk)}">
    <div class="conflict-title">
      <span class="mono">${esc(c.pk)}</span>
      <span class="badge red">${title}</span>
      ${allResolved ? '<span class="badge green">已解决</span>' : ''}
    </div>
    <table class="diff">
      <thead><tr><th style="width:110px">字段</th><th>共同祖先</th><th>${esc(oursName)}（目标）</th><th>${esc(theirsName)}（源）</th><th style="width:300px">取值</th></tr></thead>
      <tbody>
        ${c.fields.map(fc => {
          const fr = res.fields?.[fc.field];
          return `
          <tr class="conflict-field">
            <td class="field-name">${esc(fieldLabel(fc.field))}</td>
            <td class="vbase">${esc(fmtVal(fc.base))}</td>
            <td class="vours">${esc(fmtVal(fc.ours))}</td>
            <td class="vtheirs">${esc(fmtVal(fc.theirs))}</td>
            <td><div class="choice">
              <label><input type="radio" name="f-${esc(c.pk)}-${fc.field}" value="ours" ${fr?.choice === 'ours' ? 'checked' : ''}> 目标</label>
              <label><input type="radio" name="f-${esc(c.pk)}-${fc.field}" value="theirs" ${fr?.choice === 'theirs' ? 'checked' : ''}> 源</label>
              <label><input type="radio" name="f-${esc(c.pk)}-${fc.field}" value="custom" ${fr?.choice === 'custom' ? 'checked' : ''}> 自定义</label>
              <input class="custom-input" data-custom="${esc(c.pk)}|${fc.field}" type="${fieldType(fc.field) === 'number' ? 'number' : 'text'}" step="any"
                placeholder="自定义值" value="${fr?.choice === 'custom' ? esc(fr.value) : ''}">
            </div></td>
          </tr>`;
        }).join('')}
        ${c.autoFields && Object.keys(c.autoFields).length ? `
          <tr><td colspan="5" style="color:var(--text-3);font-size:12.5px">
            以下字段已自动合并：${Object.entries(c.autoFields).map(([f, src]) => `${esc(fieldLabel(f))}（取${src === 'ours' ? '目标' : '源'}）`).join('、')}
          </td></tr>` : ''}
      </tbody>
    </table>
  </div>`;
}

function autoTable(auto, s) {
  if (!auto.length) return '<div class="empty">无</div>';
  const tag = (src) => src === 'ours' ? `<span class="badge blue">${esc(s.target_branch.name)}</span>` : src === 'theirs' ? `<span class="badge" style="background:#f3eaff;color:#7c3aed">${esc(s.source_branch.name)}</span>` : '<span class="badge gray">两边</span>';
  return `
  <table class="data"><thead><tr>
    ${DATASET.fields.map(f => `<th class="${f.type === 'number' ? 'num' : ''}">${esc(f.label)}</th>`).join('')}<th>来源</th>
  </tr></thead><tbody>
    ${auto.map(m => `
      <tr>
        ${DATASET.fields.map(f => {
          const src = m.fields?.[f.name];
          return `<td class="${f.type === 'number' ? 'num' : ''} ${src ? 'cell-changed' : ''}">${esc(fmtVal(m.record[f.name]))}${src ? ' ' + tag(src) : ''}</td>`;
        }).join('')}
        <td>${Object.keys(m.fields || {}).length ? '' : '<span class="badge gray">一致</span>'}</td>
      </tr>`).join('')}
  </tbody></table>`;
}

function simpleTable(items, s) {
  if (!items.length) return '<div class="empty">无</div>';
  return `
  <table class="data"><thead><tr>
    ${DATASET.fields.map(f => `<th class="${f.type === 'number' ? 'num' : ''}">${esc(f.label)}</th>`).join('')}<th>说明</th>
  </tr></thead><tbody>
    ${items.map(it => `
      <tr>
        ${DATASET.fields.map(f => `<td class="${f.type === 'number' ? 'num' : ''}">${esc(fmtVal(it.record[f.name]))}</td>`).join('')}
        <td><span class="badge gray">${esc(it.tag)}</span></td>
      </tr>`).join('')}
  </tbody></table>`;
}

function bindMergeEvents() {
  const s = mergeState;

  // 冲突解决：所有选择即时保存（防抖），进度落库，刷新不丢
  // 注意：回调里必须用全局 mergeState（保存后会被替换为新会话对象），不能用闭包捕获的旧 s
  $$('.conflict-card input[type="radio"]', app).forEach(radio => {
    radio.addEventListener('change', () => {
      const pk = radio.closest('.conflict-card').dataset.pk;
      const c = mergeState.result.conflicts.find(x => x.pk === pk);
      const res = mergeState.resolutions[pk] || (mergeState.resolutions[pk] = {});
      if (c.type === 'delete-modify') {
        res.row = radio.value;
      } else {
        const field = radio.name.slice(`f-${pk}-`.length);
        res.fields = res.fields || {};
        const custom = $(`[data-custom="${CSS.escape(pk)}|${field}"]`, app);
        if (radio.value === 'custom') {
          res.fields[field] = { choice: 'custom', value: coerce(field, custom.value) };
        } else {
          res.fields[field] = { choice: radio.value };
        }
      }
      scheduleSave();
    });
  });
  $$('.conflict-card input[data-custom]', app).forEach(inp => {
    inp.addEventListener('input', () => {
      const [pk, field] = inp.dataset.custom.split('|');
      const res = mergeState.resolutions[pk] || (mergeState.resolutions[pk] = {});
      res.fields = res.fields || {};
      const radio = $(`input[name="f-${CSS.escape(pk)}-${field}"][value="custom"]`, app);
      if (radio.checked) { res.fields[field] = { choice: 'custom', value: coerce(field, inp.value) }; scheduleSave(); }
    });
  });

  $('#mg-cancel').addEventListener('click', async () => {
    if (!confirm('确定取消本次合并？已做的冲突解决进度将被丢弃。')) return;
    await api('POST', `/api/merges/${s.id}/cancel`);
    toast('已取消合并');
    location.hash = `#/branch/${s.target_branch.id}`;
  });
  $('#mg-recheck').addEventListener('click', async () => {
    const r = await api('POST', `/api/merges/${s.id}/recheck`);
    mergeState = r.session;
    toast('已按最新分支状态重算预览'); renderMerge();
  });
  $('#mg-reviewed')?.addEventListener('click', async () => {
    const r = await api('POST', `/api/merges/${s.id}/recheck`);
    mergeState = r.session;
    toast('已确认核对，可继续发布'); renderMerge();
  });
  $('#mg-publish').addEventListener('click', async () => {
    try {
      await saveResolutions();
      const r = await api('POST', `/api/merges/${s.id}/publish`, { message: $('#mg-msg').value.trim() || undefined });
      toast(`合并已发布为 v${r.version.num}`, 'ok');
      location.hash = `#/version/${r.version.id}`;
    } catch (e) {
      if (e.status === 409 && e.data?.session) {
        mergeState = e.data.session;
        toast(e.message, 'err', 5000);
        renderMerge();   // 预览已重算，页面顶部出现"需重新核对"横幅
      } else if (e.status === 400 && e.data?.unresolved) {
        toast(e.message, 'err'); renderMerge();
      } else toast(e.message, 'err');
    }
  });
}

function coerce(field, raw) {
  return fieldType(field) === 'number' ? (raw === '' ? null : Number(raw)) : raw;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api('PUT', `/api/merges/${mergeState.id}/resolutions`, { resolutions: mergeState.resolutions });
      mergeState.needs_review = false; // 保存解决结果即视为一次核对
    } catch (e) { toast(e.message, 'err'); }
    updateMergeBar(); // 轻量刷新计数与按钮，不打断输入焦点和滚动位置
  }, 500);
}

// 本地计算未解决数（与服务端 countUnresolved 逻辑一致），避免保存期间整体替换状态丢掉并发编辑
function localUnresolved(s) {
  let n = 0;
  for (const c of s.result.conflicts) {
    const r = s.resolutions[c.pk];
    if (c.type === 'delete-modify') { if (!(r?.row === 'keep' || r?.row === 'delete')) n++; }
    else for (const fc of c.fields) {
      const fr = r?.fields?.[fc.field];
      if (!fr || !(fr.choice === 'ours' || fr.choice === 'theirs' || (fr.choice === 'custom' && fr.value !== undefined))) n++;
    }
  }
  return n;
}

function updateMergeBar() {
  const s = mergeState;
  const n = localUnresolved(s);
  const badge = $('#mg-unresolved');
  if (badge) {
    badge.className = n ? 'badge red' : 'badge green';
    badge.textContent = n ? `还有 ${n} 处冲突未解决` : '冲突已全部解决';
  }
  const pub = $('#mg-publish');
  if (pub) pub.disabled = n > 0 || s.needs_review;
  for (const c of s.result.conflicts) {
    const card = $(`.conflict-card[data-pk="${CSS.escape(c.pk)}"]`);
    if (!card) continue;
    const res = s.resolutions[c.pk];
    const resolved = c.type === 'delete-modify'
      ? (res?.row === 'keep' || res?.row === 'delete')
      : c.fields.every(fc => res?.fields?.[fc.field]);
    card.classList.toggle('resolved', resolved);
  }
}

async function saveResolutions() {
  await api('PUT', `/api/merges/${mergeState.id}/resolutions`, { resolutions: mergeState.resolutions });
  mergeState.needs_review = false;
}

// ---------------- 视图：版本列表 / 版本详情 ----------------
async function viewVersions() {
  const s = await ensureState();
  const kindTag = { init: '<span class="kind-tag kind-init">初始</span>', commit: '<span class="kind-tag kind-commit">提交</span>', merge: '<span class="kind-tag kind-merge">合并</span>' };
  app.innerHTML = `
    <div class="page-head">
      <div><h1>版本</h1><div class="sub">每次发布形成不可变版本；旧版本永远可以查询，不会丢失。</div></div>
    </div>
    <div class="card table-wrap">
      <table class="data">
        <thead><tr><th>版本</th><th>类型</th><th>分支</th><th>父版本</th><th>变更统计</th><th>提交信息</th><th>时间</th><th></th></tr></thead>
        <tbody>
          ${s.versions.map(v => `
            <tr>
              <td class="mono"><b>v${v.num}</b></td>
              <td>${kindTag[v.kind]}</td>
              <td>${esc(v.branch_name || '-')}</td>
              <td class="mono">${v.parent_nums.length ? v.parent_nums.map(n => `v${n}`).join(' + ') : '-'}</td>
              <td>${v.stats ? [
                v.stats.added ? `<span class="badge green">+${v.stats.added}</span>` : '',
                v.stats.modified ? `<span class="badge amber">改${v.stats.modified}</span>` : '',
                v.stats.deleted ? `<span class="badge red">-${v.stats.deleted}</span>` : '',
                v.stats.auto ? `<span class="badge blue">自动${v.stats.auto}</span>` : '',
                v.stats.conflicts ? `<span class="badge red">冲突${v.stats.conflicts}</span>` : '',
              ].filter(Boolean).join(' ') || '<span class="badge gray">无变更</span>' : '-'}</td>
              <td>${esc(v.message || '')}</td>
              <td style="color:var(--text-3)">${fmtTime(v.created_at)}</td>
              <td><a class="btn small" href="#/version/${v.id}">查看数据</a></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

async function viewVersion(versionId) {
  const { version, rows } = await api('GET', `/api/versions/${versionId}`);
  await ensureState();
  const kindTag = { init: '<span class="kind-tag kind-init">初始</span>', commit: '<span class="kind-tag kind-commit">提交</span>', merge: '<span class="kind-tag kind-merge">合并</span>' };
  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>版本 <span class="mono">v${version.num}</span> ${kindTag[version.kind]}</h1>
        <div class="sub">${esc(version.message || '')} · ${version.branch_name ? `发布于分支 ${esc(version.branch_name)} · ` : ''}${fmtTime(version.created_at)} · 共 ${rows.length} 行（只读快照）</div>
      </div>
      <a class="btn" href="#/versions">← 版本列表</a>
    </div>
    <div class="card table-wrap">
      <table class="data">
        <thead><tr>${DATASET.fields.map(f => `<th class="${f.type === 'number' ? 'num' : ''}">${esc(f.label)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map(rec => `<tr>${DATASET.fields.map(f => `<td class="${f.type === 'number' ? 'num' : ''}">${esc(fmtVal(rec[f.name]))}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ---------------- 启动 ----------------
render();
