// 数据库层：本地表（SQLite）+ 不可变版本快照 + 分支 + 草稿 + 合并会话
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'dataset.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pk_field TEXT NOT NULL,
  fields TEXT NOT NULL,          -- JSON: [{name, type}]
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  num INTEGER NOT NULL,          -- 数据集内递增序号，展示为 v1/v2/...
  parents TEXT NOT NULL,         -- JSON: [versionId] 或 [targetHead, sourceHead]（合并）
  branch_id TEXT,                -- 发布所在分支
  kind TEXT NOT NULL,            -- init | commit | merge
  message TEXT,
  stats TEXT,                    -- JSON: {added, modified, deleted, auto, conflicts}
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_from_version_id TEXT NOT NULL,
  head_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(dataset_id, name)
);

-- 不可变版本的完整行快照：旧版本永远可查询
CREATE TABLE IF NOT EXISTS version_rows (
  version_id TEXT NOT NULL,
  pk TEXT NOT NULL,
  data TEXT NOT NULL,            -- JSON: 完整记录
  PRIMARY KEY (version_id, pk)
);

-- 分支工作区里的未发布修改（草稿），刷新/重启后保留
CREATE TABLE IF NOT EXISTS drafts (
  branch_id TEXT NOT NULL,
  pk TEXT NOT NULL,
  op TEXT NOT NULL,              -- insert | update | delete
  data TEXT,                     -- insert/update: 完整目标记录 JSON；delete: NULL
  updated_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, pk)
);

-- 合并会话：预览结果与逐项冲突解决进度全部落库
CREATE TABLE IF NOT EXISTS merge_sessions (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  source_branch_id TEXT NOT NULL,
  target_branch_id TEXT NOT NULL,
  base_version_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,   -- 源分支工作状态基准（其 head）
  target_version_id TEXT NOT NULL,   -- 目标分支 head（乐观并发校验用）
  source_has_draft INTEGER NOT NULL DEFAULT 0,
  target_has_draft INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL,              -- JSON: {added, deleted, auto, conflicts}
  resolutions TEXT NOT NULL DEFAULT '{}',
  needs_review INTEGER NOT NULL DEFAULT 0,  -- 目标分支被别人推进后要求重新核对
  status TEXT NOT NULL DEFAULT 'open',      -- open | published | cancelled
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();

const q = {
  getDataset: db.prepare('SELECT * FROM datasets LIMIT 1'),
  insertDataset: db.prepare('INSERT INTO datasets (id,name,pk_field,fields,created_at) VALUES (?,?,?,?,?)'),
  insertVersion: db.prepare('INSERT INTO versions (id,dataset_id,num,parents,branch_id,kind,message,stats,created_at) VALUES (?,?,?,?,?,?,?,?,?)'),
  nextVersionNum: db.prepare('SELECT COALESCE(MAX(num),0)+1 AS n FROM versions WHERE dataset_id=?'),
  insertVersionRow: db.prepare('INSERT INTO version_rows (version_id,pk,data) VALUES (?,?,?)'),
  insertBranch: db.prepare('INSERT INTO branches (id,dataset_id,name,created_from_version_id,head_version_id,created_at) VALUES (?,?,?,?,?,?)'),
};

// ---------------- 种子数据：订单 ----------------
export function seedIfEmpty() {
  if (q.getDataset.get()) return false;

  const fields = [
    { name: 'order_id',   label: '订单号',  type: 'text'   },
    { name: 'customer',   label: '客户',    type: 'text'   },
    { name: 'product',    label: '商品',    type: 'text'   },
    { name: 'quantity',   label: '数量',    type: 'number' },
    { name: 'unit_price', label: '单价',    type: 'number' },
    { name: 'status',     label: '状态',    type: 'text'   },
    { name: 'region',     label: '区域',    type: 'text'   },
  ];

  const orders = [
    ['SO-1001', '张伟',   '无线鼠标',     2,  79.0,  '已完成', '华东'],
    ['SO-1002', '李娜',   '机械键盘',     1,  349.0, '已完成', '华北'],
    ['SO-1003', '王强',   '27寸显示器',   1,  1299.0,'已发货', '华南'],
    ['SO-1004', '刘洋',   '笔记本电脑支架', 3,  89.5,  '待发货', '华东'],
    ['SO-1005', '陈静',   'USB-C 扩展坞', 1,  259.0, '待发货', '西南'],
    ['SO-1006', '杨帆',   '人体工学椅',   1,  1599.0,'待付款', '华北'],
    ['SO-1007', '赵磊',   '4K 摄像头',    2,  399.0, '待发货', '华东'],
    ['SO-1008', '孙丽',   '降噪耳机',     1,  899.0, '已发货', '华南'],
    ['SO-1009', '周杰',   '移动固态硬盘', 2,  549.0, '待付款', '华中'],
    ['SO-1010', '吴敏',   '显示器挂灯',   1,  199.0, '已完成', '华北'],
    ['SO-1011', '郑爽',   '桌面理线器',   5,  29.9,  '待发货', '华东'],
    ['SO-1012', '冯远',   '升降办公桌',   1,  2199.0,'待付款', '华南'],
    ['SO-1013', '何欢',   '无线充电器',   2,  129.0, '已发货', '西南'],
    ['SO-1014', '高翔',   '蓝牙音箱',     1,  459.0, '待发货', '华中'],
  ];

  const ts = now();
  const datasetId = uid();
  q.insertDataset.run(datasetId, '订单数据集', 'order_id', JSON.stringify(fields), ts);

  const versionId = uid();
  q.insertVersion.run(versionId, datasetId, 1, JSON.stringify([]), null, 'init', '初始订单数据', JSON.stringify({ added: orders.length, modified: 0, deleted: 0, auto: 0, conflicts: 0 }), ts);
  for (const [order_id, customer, product, quantity, unit_price, status, region] of orders) {
    q.insertVersionRow.run(versionId, order_id, JSON.stringify({ order_id, customer, product, quantity, unit_price, status, region }));
  }

  const mainId = uid();
  q.insertBranch.run(mainId, datasetId, 'main', versionId, versionId, ts);
  return true;
}
