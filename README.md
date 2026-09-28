# 蜂窝网络切换事件与掉线根因分析后端

纯本地、纯虚构数据的分析后端：TypeScript + Node.js + SQLite（better-sqlite3）。
只提供 REST API、CLI、虚构基站/终端事件生成器与自动化测试；不包含网页，不连接真实运营商网络。

## 功能概览

- 管理匿名终端、基站扇区、邻区配置版本、测量报告、切换命令/回执、信号强度、掉线事件、时钟校准与调查批次
- 原始信令按到达顺序（自增 id）与来源（source）永久保留，时间线按校正时间重放
- 切换状态机分类：正常 / 过早（too_early）/ 过晚（too_late）/ 乒乓（ping_pong）/ 缺失回执（missing_receipt）
- 乱序按校正时间重排、重复信令按内容哈希去重，二者都不会制造虚假掉线；只有显式 drop 事件产生掉线
- 根因分析同时输出证据与反证（弱覆盖 / 邻区缺配 / 容量拥塞），按净证据评分，绝不只按最近一条事件猜
- 基站时钟偏差按校准表校正；邻区配置按生效时间取当时版本；新配置或迟到事件触发重算；已发布调查不可变、可重现导出
- 时间与随机性可注入（`Clock` / `SeededRng`），测试不依赖真实等待；所有多行写入都在事务内

## 安装与测试

```powershell
npm install
npm test          # vitest：状态转移 / 去重 / 时序边界 / 根因证据 / 重启恢复 / 失败路径
npm run typecheck
```

## 启动与停止

```powershell
npm start         # 监听 127.0.0.1，端口 0 = 本机自动分配，控制台打印实际端口
# 停止：Ctrl+C（SIGINT 时正常关闭数据库）
# 自定义：$env:PORT=8080; $env:DB_PATH="data.sqlite"; npm start
```

## 端到端演示（可重复）

```powershell
npm run demo      # 重建 demo.sqlite，跑完全部场景并导出 demo-report.json
```

## CLI

```powershell
npm run cli -- fixtures                 # 生成虚构网络与全部场景事件
npm run cli -- import events.json       # 导入信令（显示导入前后计数）
npm run cli -- rebuild <terminalId>     # 重建终端时间线（显示前后状态）
npm run cli -- analyze <dropId>         # 分析掉线根因
npm run cli -- evidence <invId>         # 查看证据与反证
npm run cli -- publish <invId>          # 发布调查（之后不可变）
npm run cli -- compare-config 1 2       # 比较两个邻区配置版本
npm run cli -- export <invId>           # 导出调查报告 JSON
npm run cli -- status                   # 表计数
```

## API 摘要

统一返回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`；
错误码：`VALIDATION_ERROR`(400)、`NOT_FOUND`(404)、`CONFLICT`(409)、`INTERNAL`(500)。
列表接口支持 `cursor` / `limit` 分页。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/terminals` `/cells` | 创建匿名终端 / 基站扇区 |
| POST | `/config-versions` | 创建邻区配置版本（含条目） |
| GET | `/config-versions/compare?a=1&b=2` | 比较两个版本 |
| POST | `/config-activations` | 配置在某小区某时刻生效 |
| POST | `/clock-calibrations` | 基站时钟偏差校准 |
| POST | `/events` | 导入单个或批量信令（事务、去重） |
| GET | `/events?terminalId=&cursor=&limit=` | 分页查询原始信令 |
| POST | `/terminals/:id/rebuild` | 重建切换状态机 |
| GET | `/terminals/:id/timeline` | 查看时间线 |
| GET | `/drops` | 掉线分页查询 |
| POST | `/batches` `/batches/:id/analyze` | 调查批次 |
| POST | `/investigations` | 分析某个掉线 |
| GET | `/investigations/:id` | 证据与反证 |
| POST | `/investigations/:id/publish` | 发布（不可变） |
| GET | `/investigations/:id/export` | 导出报告 |

## 夹具场景

`src/fixtures.ts` 覆盖：高速移动、信号抖动、基站时钟错位、缺失回执、重复上报、
乒乓切换、邻区缺配（及配置修复换版）、容量拥塞。全部为虚构数据，由种子随机数生成，可重复。

## 数据与迁移

- SQLite 文件默认 `data.sqlite`（`DB_PATH` 可改），WAL 模式
- 迁移记录在 `schema_migrations`，可重复执行为空操作
- 时间线/掉线为派生数据，`rebuild` 即可从原始信令重算；已发布调查保存输入哈希快照，历史结论可重现
