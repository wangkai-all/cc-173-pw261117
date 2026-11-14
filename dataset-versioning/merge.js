// 三方合并核心：共同祖先查找 + 字段级合并 + 冲突物化
// 原则：仅一边改动的字段直接合入；两边改同一字段为不同值、删除 vs 修改 → 冲突；
//       不同字段的修改可以合并，绝不整行互相覆盖。

export function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- 最近共同祖先（版本 DAG 上 BFS） ----------
export function nearestCommonAncestor(versionA, versionB, getParents) {
  if (versionA === versionB) return versionA;
  const distFrom = (start) => {
    const dist = new Map([[start, 0]]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      for (const p of getParents(cur)) {
        if (!dist.has(p)) {
          dist.set(p, dist.get(cur) + 1);
          queue.push(p);
        }
      }
    }
    return dist;
  };
  const da = distFrom(versionA);
  const db = distFrom(versionB);
  let best = null, bestScore = null;
  for (const [v, d1] of da) {
    if (db.has(v)) {
      const d2 = db.get(v);
      const score = Math.max(d1, d2) * 1000 + d1 + d2; // 先最小化较大距离，再最小化距离和
      if (bestScore === null || score < bestScore) {
        best = v; bestScore = score;
      }
    }
  }
  return best;
}

// ---------- 字段级三方合并 ----------
// baseRows/oursRows/theirsRows: Map<pk, record>；fields: [{name,...}]（不含主键之外的限制）
export function threeWayMerge(baseRows, oursRows, theirsRows, fieldNames) {
  const added = [];      // 一边新增
  const deleted = [];    // 一边删除、另一边未动
  const auto = [];       // 可自动合并（含单边修改、双边改不同字段、双边改相同值）
  const conflicts = [];  // 需人工逐项处理

  const pks = new Set([...baseRows.keys(), ...oursRows.keys(), ...theirsRows.keys()]);

  for (const pk of pks) {
    const b = baseRows.get(pk);
    const o = oursRows.get(pk);
    const t = theirsRows.get(pk);

    if (b && !o && !t) { // 两边都删除
      deleted.push({ pk, by: 'both', record: b });
      continue;
    }
    if (!b && o && !t) { // 仅目标分支新增
      added.push({ pk, from: 'ours', record: o });
      continue;
    }
    if (!b && !o && t) { // 仅源分支新增
      added.push({ pk, from: 'theirs', record: t });
      continue;
    }
    if (!b && o && t) { // 两边都新增了同一主键
      if (eq(o, t)) { added.push({ pk, from: 'both', record: o }); continue; }
      const fc = fieldDiffs(null, o, t, fieldNames);
      conflicts.push({ pk, type: 'both-insert', base: null, ours: o, theirs: t, fields: fc });
      continue;
    }
    if (b && o && !t) { // 源分支删除
      if (eq(b, o)) { deleted.push({ pk, by: 'theirs', record: b }); continue; }
      conflicts.push({ pk, type: 'delete-modify', deletedBy: 'theirs', base: b, modified: o, modifiedBy: 'ours' });
      continue;
    }
    if (b && !o && t) { // 目标分支删除
      if (eq(b, t)) { deleted.push({ pk, by: 'ours', record: b }); continue; }
      conflicts.push({ pk, type: 'delete-modify', deletedBy: 'ours', base: b, modified: t, modifiedBy: 'theirs' });
      continue;
    }
    // 两边都存在
    if (eq(o, t)) {
      if (!eq(b, o)) auto.push({ pk, record: o, fields: markAll(o, b, fieldNames, 'both'), base: b });
      continue; // 完全未变的不进任何列表
    }
    // 字段级合并
    const merged = {};
    const fieldOrigin = {};
    const fieldConflicts = [];
    for (const f of fieldNames) {
      const bv = b?.[f], ov = o[f], tv = t[f];
      if (eq(ov, tv)) { merged[f] = ov; }
      else if (eq(bv, ov)) { merged[f] = tv; fieldOrigin[f] = 'theirs'; }
      else if (eq(bv, tv)) { merged[f] = ov; fieldOrigin[f] = 'ours'; }
      else { fieldConflicts.push({ field: f, base: bv ?? null, ours: ov ?? null, theirs: tv ?? null }); }
    }
    if (fieldConflicts.length === 0) {
      auto.push({ pk, record: merged, fields: fieldOrigin, base: b });
    } else {
      conflicts.push({ pk, type: 'field', base: b, ours: o, theirs: t, fields: fieldConflicts, autoFields: fieldOrigin, merged });
    }
  }
  const byPk = (x, y) => String(x.pk).localeCompare(String(y.pk));
  added.sort(byPk); deleted.sort(byPk); auto.sort(byPk); conflicts.sort(byPk);
  return { added, deleted, auto, conflicts };
}

function fieldDiffs(base, o, t, fieldNames) {
  const out = [];
  for (const f of fieldNames) {
    const bv = base?.[f] ?? null, ov = o[f] ?? null, tv = t[f] ?? null;
    if (!eq(ov, tv)) out.push({ field: f, base: bv, ours: ov, theirs: tv });
  }
  return out;
}

function markAll(record, base, fieldNames, origin) {
  const m = {};
  for (const f of fieldNames) if (!eq(record[f], base?.[f] ?? null)) m[f] = origin;
  return m;
}

// ---------- 根据解决方案物化最终行集 ----------
// resolutions: { [pk]: { row?: 'keep'|'delete', fields?: { [field]: {choice:'ours'|'theirs'|'custom', value?} } } }
export function materialize(result, resolutions, oursRows) {
  const finalRows = new Map();
  const handled = new Set();

  for (const a of result.added) { finalRows.set(a.pk, a.record); handled.add(a.pk); }
  for (const d of result.deleted) { handled.add(d.pk); } // 不进最终结果
  for (const m of result.auto) { finalRows.set(m.pk, m.record); handled.add(m.pk); }

  const unresolved = [];
  for (const c of result.conflicts) {
    handled.add(c.pk);
    const res = resolutions[c.pk];
    if (c.type === 'delete-modify') {
      const choice = res?.row;
      if (choice === 'delete') { /* 不写入 */ }
      else if (choice === 'keep') { finalRows.set(c.pk, c.modified); }
      else unresolved.push(c.pk);
    } else { // field / both-insert
      const record = {};
      const fieldNames = c.type === 'both-insert'
        ? Object.keys(c.ours)
        : [...new Set([...Object.keys(c.merged ?? c.ours), ...(c.fields ?? []).map(x => x.field)])];
      for (const f of fieldNames) {
        if (c.type === 'field' && c.merged && !(c.fields ?? []).some(x => x.field === f)) {
          record[f] = c.merged[f]; // 已自动合并的字段
          continue;
        }
        const conflictField = (c.fields ?? []).find(x => x.field === f);
        if (!conflictField) { record[f] = c.ours[f]; continue; }
        const r = res?.fields?.[f];
        if (!r) { unresolved.push(`${c.pk}.${f}`); continue; }
        if (r.choice === 'ours') record[f] = conflictField.ours;
        else if (r.choice === 'theirs') record[f] = conflictField.theirs;
        else if (r.choice === 'custom') record[f] = r.value;
        else unresolved.push(`${c.pk}.${f}`);
      }
      if (!unresolved.some(u => String(u).startsWith(c.pk))) finalRows.set(c.pk, record);
    }
  }

  // 未出现在任何类别里的行：两边一致，取 ours
  for (const [pk, rec] of oursRows) {
    if (!handled.has(pk)) finalRows.set(pk, rec);
  }
  return { finalRows, unresolved };
}
