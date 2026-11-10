# dsh-memory-cloud

[![npm version](https://img.shields.io/npm/v/dsh-memory-cloud.svg)](https://www.npmjs.com/package/dsh-memory-cloud)
[![license](https://img.shields.io/npm/l/dsh-memory-cloud.svg)](./LICENSE)

把当前 DSH（DeepSeek Harness）的**全部会话记忆**聚合成一幅可交互的 **3D 星云图**，并提供「神经元信号」皮肤切换。

DSH 没有独立的记忆库：每一条持久记忆都是 `$DSH_HOME/sessions` 里某个会话日志中的一条已提交事件。本插件冷读所有 `session.v4.jsonl.zstd`（concatenated zstd frames 包裹的 JSONL），把每个会话折叠成一个记忆星云团，再依据 fork 血缘、共同话题、同工作区、共享工具与时间邻近计算会话之间的关联边，最后用纯 Canvas 2D 自实现的 3D 投影渲染。

## 功能

- **记忆聚合**：zstd 分帧解码 → 提取标题、真实工作目录、消息碎片、工具集、fork 血缘、关键词；过滤运行时上下文/技能目录/纯标点等注入文本。
- **关联图**：TF-IDF 加权的话题余弦相似度 + 共享工具 + 同工作区 + 时间邻近 + fork 血缘，输出带 `kind`/权重/共享词的加权边；每节点与全局上限抑制"万能 hub"。
- **两种皮肤**
  - **星云**（默认）：不规则絮状气体云（无球核、无硬边界，参考 NASA 星系云团），团间用细电弧连接；电流靠**沿线明暗渐变**表现传递，暗区纯黑、余晖自然衰减。
  - **神经元**：细胞体 + 递归分叉的树状树突 + 突触终扣 + 弯曲轴突，共用同一套信号波与流速。
- **暗星星核**：中央黑洞奇点搭配紫色能量边缘、前后分层的倾斜吸积盘、淡金色流光与旋转碎片；星尘缓慢向内卷入，实时对话与等待状态增强光晕。星云、神经元两种皮肤共用星核效果，标题会避让星环。
- **规模映射真实数据**：云团凝聚核数、光斑数、纤维/尘埃密度、记忆星数量、树突主干数与分叉深度，全部按该会话的实际碎片数/事件数归一化缩放。
- **实时记忆流**：插件订阅 Host 的 `session/event`（提交后追加流），通过 SSE 把"记忆正在写入 / 正在被读取"推到页面。右下角 HUD 显示写入/读取计数、事件速率与滚动活动流；画布上同步出现**写入涟漪向外扩散、读取涟漪向内收拢**、新生记忆星，以及被激活星云团持续数秒的热晕。对话开始时若该会话还没落盘，会先长出一个**临时星云团**，落盘后自动并入正式数据。工具调用类噪声事件按 600ms 合并，避免刷屏。
- **分级细节（LOD）**：缩放即钻取，每放大一级就多露出一层记忆。放大到 2 级以上时视角会平滑"飞入"目标星团，其余云团退到四周雾中；缩回后自动释放焦点。双击星团可直接钻到底。

  | 等级 | 徽章 | 触发缩放 | 显示内容 |
  |---|---|---|---|
  | 0 | 全景 | < 1.5× | 云团 + 会话标题 |
  | 1 | 星团 | ≥ 1.5× | 标题 + 记忆条数/对话数/工具数 |
  | 2 | 记忆摘要 | ≥ 2.8× | 自动聚焦最近星团并浮现碎片摘要 + 话题关键词 |
  | 3 | 记忆全文 | ≥ 5× | 按需拉取该会话**完整未截断**碎片（含全文标记） |
- **交互**：拖拽/单指旋转、滚轮/双指捏合缩放、悬停 tooltip、点击云团展开该会话记忆、按标题/正文/工作区搜索、点击图例聚焦工作区。
- **移动端适配**：`viewport-fit=cover` + safe-area、横向图例、全宽底部抽屉、触摸命中放大、dpr 上限 1.25。
- **性能架构**：
  - **服务端解码**：采用持久化磁盘元数据缓存（`PersistentCache`，存储于 `$DSH_HOME/storages/dsh-memory-cloud/cache.json`），历史会话在启动与刷新时 0 秒直接读取已折叠的小结构，实现 0 次多余 zstd 解压缩；针对未缓存文件，复用底层 Node 原生 zlib stream handle 进行多帧高速解压（较单帧同步解压快 6 倍）；结合零内存分配换行扫描器（提前过滤 80%+ 的工具与内部大事件）和协作式时间片切片调度（`setImmediate` 让渡），彻底消除长任务卡死主线程与内存膨胀。
  - **客户端渲染**：离屏渐变精灵缓存、按颜色/深度批量绘制；电流相位由真实时钟连续推进，渐变采样点随链路屏幕长度自适应（约每 6px 一个色标），波峰亚色标平滑移动；前端定时对账调整为 60 秒并具备页面可见性感知（后台挂起防开销）；移动端 dpr 上限 1.25。

## 安装

已发布到 npm：**<https://www.npmjs.com/package/dsh-memory-cloud>**

```bash
# 方式一：DSH CLI
dsh plugin --profile web add dsh-memory-cloud

# 方式二：在 DSH 对话里让 agent 安装
plugin_manager install_bundle dsh-memory-cloud
```

也可以在 **Settings → Plugins** 里安装。安装后 bundle 会在当前 profile 全局启用。

本地开发时改成安装目录即可（该方式为软链接，改动即时生效）：

```bash
plugin_manager install_bundle D:\dsh-memory-cloud
```

安装成功后，从左侧栏底部的「记忆星云」按钮打开；也可直接访问：

```
http://127.0.0.1:3080/memory-cloud/
```

> 该 URL 无需 DSH Web GUI 的启动 token（插件路由自带 Host 头校验，仅允许 localhost）。

## 卸载

```bash
dsh plugin --profile web remove dsh-memory-cloud
```

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：扫描/解码会话日志、聚合记忆与关联、注册 `/memory-cloud/*` HTTP 路由 |
| `client.js` | Client 半：`sidebar.footer.action` 入口按钮 + `shell.overlay` 全屏层 + locale |
| `nebula.js` | 3D 投影、两种皮肤渲染、信号波、交互与命中测试 |
| `nebula.html` / `nebula.css` | 页面骨架与响应式深色样式 |
| `cordis.patch.yml` | Loader patch，插入插件行并声明配置 |
| `locale/*.json` | Plugin Manager 显示用的中英文标题/描述 |
| `icon.svg` / `assets/icon.svg` | 插件图标 |

## 配置

`cordis.patch.yml` 中可调整：

```yaml
sessionsDir: !!js dshHomePath('sessions')  # 会话日志目录
maxSessions: 400        # 最多聚合多少个会话
maxFragments: 28        # 每个会话抽样的记忆碎片上限
maxFragmentChars: 220   # 单条碎片字数上限
trustedHosts: []        # 额外允许访问插件路由的 Host
```

## 数据接口

`GET /memory-cloud/api/memories` —— 聚合摘要（每会话最多抽样 `maxFragments` 条碎片）：

```json
{
  "generatedAt": 0,
  "sessions": [{ "id", "title", "workspaceLabel", "counts", "fragments", "topics", "tools", "parentSession", "createdAt", "updatedAt" }],
  "workspaces": [{ "id", "label", "sessions" }],
  "relations": [{ "source", "target", "weight", "kind", "kinds", "shared" }],
  "stats": { "sessions", "relations", "fragments", "events", "user", "assistant", "tools", "turns", "oldest", "newest" }
}
```

`GET /memory-cloud/api/session/:id` —— 单个会话的**完整**碎片（LOD 3 按需拉取，按文件 mtime 缓存；未知 id 返回 404）：

```json
{ "id", "title", "workspaceLabel", "createdAt", "updatedAt", "counts", "fragments": [{ "kind", "text", "truncated", "time", "seq" }] }
```

`GET /memory-cloud/api/live` —— **SSE 实时记忆活动流**（`text/event-stream`，15 秒心跳，连接建立时回放最近 24 条）：

```json
{ "seq", "sessionId", "sessionTitle", "kind": "write" | "read", "type", "text", "tool", "time" }
```

`kind` 语义：`write` = 一条记忆刚被提交写入会话日志（用户消息、助手消息、会话标题）；`read` = 一条记忆正被读取/引用（工具调用与结果、上下文注入、压缩整理、轮次结束）。

插件对会话日志与 profile **只读**，不写入任何状态；唯一的持久化是浏览器 `localStorage` 里的皮肤选择。

## 许可

MIT
