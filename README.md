# TCGinFU 卡牌浏览器

把 TCGinFU 内容包（`Assets/StreamingAssets/Content` 里的 json + lua）拼成一个策划能直接读的卡牌目录，顺便做一遍一致性检查。

**只读工具**：它不改内容包里的任何文件。改卡还是改 json / lua，改完页面会自动刷新。

## 怎么用

需要 [Node.js](https://nodejs.org/) 18 或更新版本，不用装任何依赖。

**策划日常**：双击 `打开卡牌浏览器.cmd`。浏览器会打开 <http://localhost:5178/>，内容包一有改动页面就自动刷新。用完关掉黑色窗口即可。

**命令行**：

```powershell
node build.js                 # 生成 dist/ 下的所有文件
node build.js --open          # 生成后直接打开 dist/index.html
node build.js --serve --open  # 本机网页 + 自动刷新（就是双击 .cmd 做的事）
node build.js --check         # 只跑检查；有「错误」时退出码为 1，可以挂到提交前或 CI
npm test                      # 跑工具自己的测试
```

内容包的位置写在 `cardbrowser.config.json` 里，默认是同级目录下的 `../TCGinFU/Assets/StreamingAssets/Content`。工程放在别处时，新建一个 `cardbrowser.local.json`（不进仓库）覆盖它，或者用 `--content <目录>` 指定。

## 生成什么

| 文件 | 用途 |
|---|---|
| `dist/index.html` | 单文件网页，数据都在里面，可以直接发给别人用浏览器打开 |
| `dist/cards.md` | 按角色、职业整理的卡牌目录，可以贴进 `Assets/docs/` 或任何文档工具 |
| `dist/cards.csv` | 总表，用 Excel 打开中文不乱码，方便排序、对比数值 |
| `dist/report.md` | 检查报告 |

## 网页里有什么

- **卡牌**：卡片视图和表格视图两种。可以按角色、职业、类别、种类、颜色、AP 和状况（有错误、有警告、有没有 Lua）筛选，也可以按卡名、id、卡面文字或钩子名搜索（按 `/` 聚焦搜索框）。点开一张卡能看到：
  - 卡面文字（【状态名】悬停显示状态说明）和全部数值
  - 数据效果，翻译成中文句子
  - 对应的 Lua 行为：挂了哪些钩子、每个钩子什么时候触发、脚本作者写的说明，以及带行号的代码
  - 它在哪些卡组里放了几张
  - 迁移遗留字段（unmapped），以及这张卡相关的检查结果
- **角色与卡组**：角色数值，主卡组和每个形态卡组的构成和颜色分布
- **状态**：每个状态的效果、数据字段、Lua 行为，以及谁会施加或提到它
- **敌人**：敌人数值、属性抗性、意图池，每条意图的伤害、目标和 Lua
- **Lua 行为**：按脚本文件列出每个行为、它的钩子和使用者
- **检查报告**：按问题类型分组，点问题能直接跳到对应的卡

链接可以分享：地址栏的 `#cards/card:<id>` 会直接打开那张卡。

## 检查规则

| 级别 | 代码 | 查什么 |
|---|---|---|
| 错误 | `missing-file` / `bad-json` | pack.json 列的文件不存在，或者 JSON 写坏了 |
| 错误 | `behaviour-missing` | 卡没有数据效果，指向的 Lua 行为也不存在，打出后什么都不会发生；或者状态的行为不存在 |
| 警告 | `behaviour-missing` | 卡的 Lua 行为不存在，只有数据效果在生效 |
| 错误 | `status-missing` | Lua 里 `apply_status` 等调用用了 statuses.json 里没有的状态 |
| 错误 | `*-missing-card` / `intent-missing` | 卡组、角色或意图池引用了不存在的东西 |
| 错误 | `duplicate-id` / `duplicate-behaviour` | id 重复，后加载的会覆盖前面的 |
| 警告 | `text-drift` | Lua 注释里抄的卡面原文和现在的卡面对不上，可能卡面改了脚本没跟上。只差括注（如「本5级构筑为12点」）的不算 |
| 警告 | `unknown-hook` | Lua 钩子名引擎不认识。钩子列表直接从 Unity 工程的 `LuaCardBehaviour.cs` / `LuaProxies.cs` 读，找不到源码时用内置表 |
| 警告 | `number-mismatch` | 数据效果的数值在卡面上找不到，比如数据是 5 点，卡面写 7 点 |
| 警告 | `crit-flag` | `hasCrit` 和卡面上的【暴击】不一致 |
| 警告 | `behaviour-unused` / `behaviour-unlinked` | Lua 行为没人引用，或者意图疑似漏写了 behaviourId |
| 警告 | `unlisted-file` | 目录里有文件，但 pack.json 没列，引擎不会读 |
| 提示 | `no-behaviour-id` / `not-in-deck` | 供核对 |

## 结构

```
build.js            命令行入口：生成 / 监视 / 本机服务 / 检查
src/load.js         按 pack.json 读内容包
src/lua.js          从 Lua 里切出 behaviour("id", {...}) 块、钩子、注释、状态引用
src/engine.js       从 Unity 工程的 C# 源码读引擎认识的钩子名
src/model.js        连好引用、跑检查
src/labels.js       英文枚举 → 中文
src/render.js       输出 HTML / Markdown / CSV / 报告
src/web/            网页模板、样式和脚本（生成时内联成单文件）
test/               测试与测试用的迷你内容包
```

## 后续可以做的

- 表格往返编辑：导出可编辑的表格，策划改完数值和文字再导回 json，导回前先校验，并给开发一份 diff
- 给开发侧的 VS Code 插件：在 json 里悬停 `behaviourId` 显示卡面，点一下跳到 Lua
