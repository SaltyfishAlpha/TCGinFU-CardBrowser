# TCGinFU 卡牌浏览器

json + lua 内容包的策划工具，做三件事：

1. **看**：把内容包拼成策划能直接读的卡牌目录（网页 / Markdown / CSV），并跑一致性检查。
2. **改**：导出成 Excel 表格，策划在表里改、增、删卡和效果，再导回 json。
3. **交接**：导入时自动生成 Lua 占位和给 agent 的任务单，agent 实现、测试完，检查报告里那一项就会消失。

工具本身不绑定 TCGinFU：字段、表头、枚举、文件放置规则、Lua 写法都写在 `profiles/<项目>/profile.json` 里（见下文「换一个项目」）。

需要 [Node.js](https://nodejs.org/) 18 或更新版本，不用装任何依赖，也不需要装 Excel 插件。

## 发布版（给策划）

```powershell
npm run release
```

生成 `release/TCGinFU卡牌工具/` 和同名 zip（约 34 MB）。包里自带 Node 运行时（`runtime\node.exe`），解压就能用，电脑上不用装任何东西：

- `导出卡牌表.cmd` / `导入卡牌表.cmd` / `打开卡牌浏览器.cmd` 三个按钮
- 表格就在文件夹根目录：`卡牌表.xlsx`；任务单、导入记录在 `输出\` 下
- 第一次运行会在附近自动找 TCGinFU 工程，找不到就请用户把工程文件夹拖进窗口，然后记在 `cardbrowser.local.json` 里
- `使用说明.txt` 是给策划看的说明

`npm run release -- --no-runtime` 打不带运行时的小包（给已经装了 Node 的人）。

## 两条工作流

### 出新卡

1. 双击 `导出卡牌表.cmd`，Excel 会打开 `dist/卡牌表.xlsx`。
2. 在「卡牌」表最下面新起一行，填 id、卡名、角色、类别、种类、卡面文字等；在「效果」表里给它加数据效果（能用数据表达的部分，比如「造成 4 点冰伤害」）。
3. 保存，双击 `导入卡牌表.cmd`（或者把 xlsx 拖到它上面）。它会先列出每一处改动，回答 `y` 才写入。
4. 写入后：
   - 新卡进了 json（默认按规则放进 `cards/<角色>.json`，形态牌放进 `cards/forms.json`）；
   - 对应的 Lua 文件末尾多了一段 **待实现占位**：照抄卡面，`behaviour(...)` 部分保持注释状态（引擎的 L02 测试要求注册的行为至少挂一个钩子，空行为会让测试失败）；
   - `dist/agent-tasks.md` 是给 agent 的任务单：每张卡的卡面、已有的数据效果、占位在哪一行、测试写在哪。
5. 把任务单交给 agent。agent 实现 Lua、写测试、把注释里的卡面原文更新好之后，跑 `node build.js --check`，那张卡就不会再出现在报告里。

### 改已有的卡

1. 导出 → 在表里改数值、卡面文字、效果，或者在「删除」列选「删除」。
2. 导入。工具和导出时的版本做**三方比对**：
   - 只有你在表里改过的格子会写回，其它格子原样保留；
   - 导出之后 json 被别人（比如 agent）改过、你也改了同一格 → 记为**冲突**，不覆盖，预览里会列出三方的值。确认用表里的值，就加 `--force` 重新导入；
   - 被卡组或角色引用的卡不能删，导入时会告诉你是谁在用它。
3. 任务单会列出需要 agent 跟进的地方：
   - 卡面改了、而这张卡已经有 Lua → 「核对 / 修改已有 Lua」，附新旧卡面；
   - 数值或数据效果改了 → 「确认 Lua 不冲突」（Lua 里可能写死了数，或者和数据效果重复结算）；
   - 卡删了、行为也没人用了 → 「确认后删除 Lua」；
   - 还是占位的卡改了卡面 → 工具直接更新占位里的原文，不需要 agent 做什么。

改动写进 json 时保留原文件的缩进、换行符和键顺序，`git diff` 里只会出现真正改了的行。

## 怎么用

**看卡**：双击 `打开卡牌浏览器.cmd`。浏览器会打开 <http://localhost:5178/>，内容包一有改动页面就自动刷新。用完关掉黑色窗口即可。

**命令行**：

```powershell
node build.js                 # 生成 dist/ 下的网页、目录、CSV、检查报告
node build.js --open          # 生成后直接打开 dist/index.html
node build.js --serve --open  # 本机网页 + 自动刷新（就是双击 .cmd 做的事）
node build.js --check         # 只跑检查；有「错误」时退出码为 1，可以挂到提交前或 CI
node build.js export                         # 导出 dist/卡牌表.xlsx（--xlsx 换文件名）
node build.js import 卡牌表.xlsx             # 预览：会改什么、冲突、错误。不写任何文件
node build.js import 卡牌表.xlsx --apply     # 写入 json、Lua 占位，生成 agent 任务单
node build.js import 卡牌表.xlsx --confirm   # 预览后问一句再写（双击导入用的就是这个）
npm test                      # 跑工具自己的测试
```

每次导入的预览、记录和任务单都留在 `dist/import/` 下，带时间戳。

内容包的位置写在 `cardbrowser.config.json` 里，默认是同级目录下的 `../TCGinFU/Assets/StreamingAssets/Content`。工程放在别处时，新建一个 `cardbrowser.local.json`（不进仓库）覆盖它，或者用 `--content <目录>` 指定。

## 卡牌表里有什么

| 表 | 内容 |
|---|---|
| 卡牌 | 一行一张卡。浅蓝表头可以改，黄色表头是 id，灰色列（Lua状态）只是给你看的 |
| 效果 | 一行一条数据效果，用「卡牌id」对应到卡，「序号」决定先后 |
| 状态 | 一行一个状态 |
| 枚举 | 下拉框的可选值 |
| 说明 | 填表规则 |
| _meta（隐藏） | 导出时每一项的原样 JSON，三方比对靠它。不要删 |

几条填表规则：
- 有下拉框的列从下拉里选，中文和英文原值都认。多选列（颜色）用 `+` 连接，比如 `敏捷+洞察`。
- 「Lua行为」：留空表示用 id 作为行为名（新卡会生成占位）；填 `无` 表示这张卡只靠数据效果。
- 「其它字段(JSON)」：表里没有单独列出来的字段（比如迁移遗留的 `unmapped`）。看不懂就别动，导入时会原样保留。
- 列可以挪位置、可以隐藏，也可以删掉不关心的列（删掉的列对应的字段保持不变）。
- 不支持改 id：删掉旧行，再新加一行。

## 换一个项目

复制 `profiles/tcginfu/` 改一份，用 `--profile profiles/<新项目>`（或者在 `cardbrowser.local.json` 里写 `"profile"`）指定。`profile.json` 描述：

- `collections`：每类数据在哪些文件里（从清单文件读，或者用 `files: ["monsters/*.json"]` 通配），`id` 是哪个字段，文件根是数组、`{ "cards": [...] }` 还是单个对象。
- `columns`：表里有哪些列，每列对应哪个字段（支持 `amount.add` 这样的嵌套路径），以及类型：`string` / `text` / `int` / `number` / `bool` / `enum` / `list` / `json` / `behaviour`。
- `children`：数组字段拆成子表，比如卡的 `effects`。
- `newFile`：新项放进哪个文件，按字段匹配规则，比如 `{ "when": { "kind": "Form" }, "file": "cards/forms.json" }`。
- `references`：谁引用了这类数据，删除时用来保护。
- `lua`：脚本文件、注册函数名、占位模板、占位放进哪个文件。
- `tasks.intro`：任务单开头给 agent 的说明（测试写在哪、写法约定在哪）。

`test/generic/` 里有一套和 TCGinFU 无关的示例（怪物 + 技能 + `register(...)` 式 Lua），测试用它跑完整的导出 / 导入 / 占位流程。

说明：目前**网页浏览器**部分（卡组、敌人、检查规则）还是按 TCGinFU 的结构写的；表格往返、Lua 占位和任务单这部分是通用的。

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
| 提示 | `behaviour-pending` | 卡牌表导入时生成的 Lua 占位，还没实现 |
| 提示 | `no-behaviour-id` / `not-in-deck` | 供核对 |

## 结构

```
build.js              命令行入口：生成 / 监视 / 本机服务 / 检查 / 导出 / 导入
profiles/tcginfu/     TCGinFU 的项目描述（字段、表头、枚举、文件规则、Lua 占位模板、任务单说明）
src/profile.js        读项目描述；单元格 ⇄ json 值的转换
src/store.js          通用的内容包读写，保持原文件格式
src/xlsx.js           零依赖的 xlsx 读写（zip + XML，压缩用 Node 自带的 zlib）
src/sheet.js          导出表格；导入时三方比对、校验，生成导入计划
src/apply.js          执行计划：改 json、Lua 占位，生成预览 / 记录 / agent 任务单
src/load.js           网页浏览器用：按 pack.json 读内容包
src/lua.js            切出 behaviour("id", {...}) 块、钩子、注释、状态引用、待实现占位
src/engine.js         从 Unity 工程的 C# 源码读引擎认识的钩子名
src/model.js          网页浏览器用：连好引用、跑检查
src/labels.js         英文枚举 → 中文（以 profile 为准）
src/render.js         输出 HTML / Markdown / CSV / 报告
src/web/              网页模板、样式和脚本（生成时内联成单文件）
test/                 测试；test/generic 是一套和 TCGinFU 无关的示例项目
```

## 后续可以做的

- 网页浏览器也改成按 profile 驱动（现在卡组、敌人视图和部分检查是按 TCGinFU 写的）
- 卡组也做成可编辑的表（profile 里加一个集合就行，主要是设计卡组表的样子）
- 给开发侧的 VS Code 插件：在 json 里悬停 `behaviourId` 显示卡面，点一下跳到 Lua
