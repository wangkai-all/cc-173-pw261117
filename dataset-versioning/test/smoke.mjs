// 端到端冒烟测试：分支编辑 → 三方合并 → 冲突解决 → 发布 → 双人对同一目标版本提交 → 取消 → 重启持久化
// 运行：node test/smoke.mjs   （独立临时数据库，不影响演示数据）
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8091;
const BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'dv-smoke-'));
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

let passed = 0, failed = 0;
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
const api = async (method, path, body, expectStatus = 200) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const server = spawn('node', [serverPath], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dir }, stdio: 'pipe' });
server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/state'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server not ready');
}

async function restart() {
  server.kill('SIGTERM');
  await new Promise(r => server.once('exit', r));
  const s2 = spawn('node', [serverPath], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dir }, stdio: 'pipe' });
  s2.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  await waitReady();
  return s2;
}

try {
  await waitReady();
  console.log('\n■ 初始数据与分支');
  let st = (await api('GET', '/api/state')).data;
  ok(st.dataset.name === '订单数据集' && st.branches.length === 1 && st.versions.length === 1, '种子数据：main 分支 + v1');
  const main = st.branches[0];
  const v1 = st.versions[0];

  const brA = (await api('POST', '/api/branches', { name: '客服组', from_version_id: v1.id })).data.branch;
  const brB = (await api('POST', '/api/branches', { name: '运营组', from_version_id: v1.id })).data.branch;
  ok(brA && brB, '从同一版本 v1 开出两个分支');
  const dup = await api('POST', '/api/branches', { name: '客服组', from_version_id: v1.id });
  ok(dup.status === 409, '分支重名被拒绝');

  console.log('\n■ 两个分支各自编辑（草稿）');
  const put = (b, pk, body) => api('PUT', `/api/branches/${b}/draft/${encodeURIComponent(pk)}`, body);
  // A：改 SO-1003 状态、改 SO-1004 数量、删 SO-1009、增 SO-2001
  await put(brA.id, 'SO-1003', { op: 'update', data: { order_id: 'SO-1003', customer: '王强', product: '27寸显示器', quantity: 1, unit_price: 1299, status: '已送达', region: '华南' } });
  await put(brA.id, 'SO-1004', { op: 'update', data: { order_id: 'SO-1004', customer: '刘洋', product: '笔记本电脑支架', quantity: 5, unit_price: 89.5, status: '待发货', region: '华东' } });
  await put(brA.id, 'SO-1009', { op: 'delete' });
  await put(brA.id, 'SO-2001', { op: 'insert', data: { order_id: 'SO-2001', customer: '测试甲', product: '键盘膜', quantity: 2, unit_price: 19.9, status: '待付款', region: '华东' } });
  // B：改 SO-1003 状态（不同值→冲突）、改 SO-1004 区域（不同字段→自动合并）、删 SO-1006、改 SO-1009（与 A 的删除冲突）、增 SO-2002
  await put(brB.id, 'SO-1003', { op: 'update', data: { order_id: 'SO-1003', customer: '王强', product: '27寸显示器', quantity: 1, unit_price: 1299, status: '已取消', region: '华南' } });
  await put(brB.id, 'SO-1004', { op: 'update', data: { order_id: 'SO-1004', customer: '刘洋', product: '笔记本电脑支架', quantity: 3, unit_price: 89.5, status: '待发货', region: '华北' } });
  await put(brB.id, 'SO-1006', { op: 'delete' });
  await put(brB.id, 'SO-1009', { op: 'update', data: { order_id: 'SO-1009', customer: '周杰', product: '移动固态硬盘', quantity: 3, unit_price: 549, status: '待付款', region: '华中' } });
  await put(brB.id, 'SO-2002', { op: 'insert', data: { order_id: 'SO-2002', customer: '测试乙', product: '鼠标垫', quantity: 1, unit_price: 29.9, status: '待付款', region: '华北' } });

  let wsA = (await api('GET', `/api/branches/${brA.id}/workspace`)).data;
  ok(wsA.drafts.length === 4 && wsA.rows.filter(r => r.state !== 'clean').length === 4, '分支 A 工作区显示 4 处草稿');
  const row1003 = wsA.rows.find(r => r.pk === 'SO-1003');
  ok(row1003.state === 'modified' && row1003.changed.includes('status') && !row1003.changed.includes('region'), '修改行按字段高亮（仅 status）');

  console.log('\n■ 三方合并预览（B → A）');
  const mg = (await api('POST', '/api/merges', { source_branch_id: brB.id, target_branch_id: brA.id })).data.session;
  ok(mg.base_version_num === 1, '共同祖先为 v1');
  ok(mg.result.conflicts.length === 2, `冲突 2 条（实际 ${mg.result.conflicts.length}）`);
  const c1003 = mg.result.conflicts.find(c => c.pk === 'SO-1003');
  const c1009 = mg.result.conflicts.find(c => c.pk === 'SO-1009');
  ok(c1003?.type === 'field' && c1003.fields.length === 1 && c1003.fields[0].field === 'status', 'SO-1003 字段级冲突（status）');
  ok(c1009?.type === 'delete-modify' && c1009.deletedBy === 'ours', 'SO-1009 删除/修改冲突');
  ok(mg.result.added.length === 2, `新增 2 条（实际 ${mg.result.added.length}）`);
  ok(mg.result.deleted.length === 1 && mg.result.deleted[0].pk === 'SO-1006', '删除 1 条（SO-1006）');
  const auto1004 = mg.result.auto.find(a => a.pk === 'SO-1004');
  ok(auto1004 && auto1004.record.quantity === 5 && auto1004.record.region === '华北', 'SO-1004 不同字段自动合并（数量取A、区域取B），不整行覆盖');

  console.log('\n■ 冲突未解决时禁止发布');
  const pubEarly = await api('POST', `/api/merges/${mg.id}/publish`, {});
  ok(pubEarly.status === 400, '未解决冲突 → 400');

  console.log('\n■ 逐项解决冲突并发布');
  const resolutions = {
    'SO-1003': { fields: { status: { choice: 'theirs' } } },          // 取源分支：已取消
    'SO-1009': { row: 'keep' },                                        // 保留 B 的修改
  };
  const saved = (await api('PUT', `/api/merges/${mg.id}/resolutions`, { resolutions })).data.session;
  ok(saved.unresolved_count === 0, '冲突全部解决');
  const pub = await api('POST', `/api/merges/${mg.id}/publish`, { message: '合并运营组修改' });
  ok(pub.status === 200 && pub.data.version.parents.length === 2, '发布成功，新版本有两个父版本');
  const mergeVer = pub.data.version;

  const rows = (await api('GET', `/api/versions/${mergeVer.id}`)).data.rows;
  const byPk = Object.fromEntries(rows.map(r => [r.order_id, r]));
  ok(byPk['SO-1003'].status === '已取消', '冲突字段按解决方案取值（已取消）');
  ok(byPk['SO-1004'].quantity === 5 && byPk['SO-1004'].region === '华北', '自动合并字段都生效');
  ok(byPk['SO-1009'] && byPk['SO-1009'].quantity === 3, '删除/修改冲突：保留修改');
  ok(!byPk['SO-1006'], 'SO-1006 已删除');
  ok(byPk['SO-2001'] && byPk['SO-2002'], '两边新增都合入');
  ok(rows.length === 15, `合并后 15 行（实际 ${rows.length}）`);

  const v1rows = (await api('GET', `/api/versions/${v1.id}`)).data.rows;
  ok(v1rows.length === 14, '旧版本 v1 仍可查询（14 行，不可变）');
  wsA = (await api('GET', `/api/branches/${brA.id}/workspace`)).data;
  ok(wsA.drafts.length === 0 && wsA.branch.head_num === mergeVer.num, '目标分支草稿已清空，head 指向合并版本');

  console.log('\n■ 两人基于同一目标版本提交：后来者必须重新核对');
  // 甲：发起 A → B 的合并（此时 B 的 head 为 H1）
  const mg2 = (await api('POST', '/api/merges', { source_branch_id: brA.id, target_branch_id: brB.id })).data.session;
  ok(mg2.status === 'open', '甲创建合并会话');
  // 乙：同时在 B 上直接发布一个提交（B 的 head 推进到 H2）
  await put(brB.id, 'SO-1002', { op: 'update', data: { order_id: 'SO-1002', customer: '李娜', product: '机械键盘', quantity: 2, unit_price: 349, status: '已完成', region: '华北' } });
  const wsB = (await api('GET', `/api/branches/${brB.id}/workspace`)).data;
  const pubB = await api('POST', `/api/branches/${brB.id}/publish`, { expected_head: wsB.branch.head_version_id, message: '乙的提交' });
  ok(pubB.status === 200, '乙先发布成功');
  // 甲再发布合并 → 必须 409，不能悄悄覆盖乙的内容
  const pub2 = await api('POST', `/api/merges/${mg2.id}/publish`, {});
  ok(pub2.status === 409, '甲的合并发布被拒绝（409）');
  ok(pub2.data.session.needs_review === true, '会话被标记为需重新核对');
  ok(pub2.data.session.target_version_num === pubB.data.version.num, '预览已按乙的新 head 重算');
  // 甲核对后重发
  const recheck = await api('POST', `/api/merges/${mg2.id}/recheck`);
  ok(recheck.data.session.needs_review === false, '甲重新核对');
  const pub3 = await api('POST', `/api/merges/${mg2.id}/publish`, {});
  ok(pub3.status === 200, '核对后发布成功');
  const rowsB = (await api('GET', `/api/versions/${pub3.data.version.id}`)).data.rows;
  const b1002 = rowsB.find(r => r.order_id === 'SO-1002');
  ok(b1002.quantity === 2, '乙先提交的内容完好（未被悄悄覆盖）');

  console.log('\n■ 草稿发布的乐观并发');
  const wsB2 = (await api('GET', `/api/branches/${brB.id}/workspace`)).data;
  await put(brB.id, 'SO-1001', { op: 'update', data: { order_id: 'SO-1001', customer: '张伟', product: '无线鼠标', quantity: 3, unit_price: 79, status: '已完成', region: '华东' } });
  const stale = await api('POST', `/api/branches/${brB.id}/publish`, { expected_head: v1.id, message: '过期 head' });
  ok(stale.status === 409, '过期 expected_head 被拒绝');
  const fresh = await api('POST', `/api/branches/${brB.id}/publish`, { expected_head: wsB2.branch.head_version_id, message: '正常发布' });
  ok(fresh.status === 200, '正确 head 发布成功');

  console.log('\n■ 取消合并');
  const mg3 = (await api('POST', '/api/merges', { source_branch_id: brB.id, target_branch_id: brA.id })).data.session;
  const cancel = await api('POST', `/api/merges/${mg3.id}/cancel`);
  ok(cancel.status === 200, '取消合并成功');
  const mg3after = (await api('GET', `/api/merges/${mg3.id}`)).data.session;
  ok(mg3after.status === 'cancelled', '会话状态为已取消');

  console.log('\n■ 刷新/重启后分支与处理进度保留');
  await put(brA.id, 'SO-1005', { op: 'update', data: { order_id: 'SO-1005', customer: '陈静', product: 'USB-C 扩展坞', quantity: 2, unit_price: 259, status: '已发货', region: '西南' } });
  const mg4 = (await api('POST', '/api/merges', { source_branch_id: brA.id, target_branch_id: brB.id })).data.session;
  await api('PUT', `/api/merges/${mg4.id}/resolutions`, { resolutions: { __probe: { row: 'keep' } } });
  const server2 = await restart();   // 重启服务进程
  const wsA2 = (await api('GET', `/api/branches/${brA.id}/workspace`)).data;
  ok(wsA2.drafts.some(d => d.pk === 'SO-1005'), '重启后草稿仍在');
  const mg4after = (await api('GET', `/api/merges/${mg4.id}`)).data.session;
  ok(mg4after.status === 'open' && mg4after.resolutions.__probe?.row === 'keep', '重启后合并会话与解决进度仍在');
  const st2 = (await api('GET', '/api/state')).data;
  ok(st2.branches.length === 3 && st2.versions.length >= 5, '重启后分支与版本完整');

  server2.kill('SIGTERM');
  await new Promise(r => server2.once('exit', r));
} catch (e) {
  failed++;
  console.error('测试异常：', e);
  server.kill('SIGTERM');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
