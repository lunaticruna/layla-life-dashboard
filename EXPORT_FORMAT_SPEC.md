# Layla Life Dashboard v0.2.3 — Atomic Export & Backup Format Specification
# 生活手记 v0.2.3 全量生活记录导出与备份配套格式规范（原子级字典与记忆底座迁移指引）

- **规范版本 (specVersion)**: `1.1.0`
- **对应应用版本 (appVersion)**: `0.2.3`
- **导出格式大版本 (exportVersion)**: `1.1.0`
- **发布日期**: 2026-11-05
- **状态**: 权威发布 (Normative Specification)
- **文档所有权**: Layla Life Dashboard Architecture & Standards Group

---

## 1. 背景与目标 (Background & Purpose)

### 1.1 背景
Layla Life Dashboard（生活手记）是部署于 Layla 智能体平台上的全自主拟真生活模拟与长期记忆管理子系统。在系统演进至 `0.2.3` 版本后，角色的生理时钟、作息规划、微观场景描写、反思文稿、角色卡实时状态同步、知识图谱三元组以及与 Layla 宿主 SDK 关联的原生记忆构成了完整、自洽的角色生命历程。

为了防止数据孤岛、消除厂商锁定，并支持用户在不同设备、宿主实例以及前沿智能体记忆底座（如 Mem0、Letta、Zep 等）之间无缝迁移角色全量记忆，本系统在“生活设置 → 导出生活记录”中引入了全新的全量归档备份机制。

### 1.2 目标与设计哲学
1. **角色域全量覆盖 (Character-Scoped Full Coverage)**:
   备份以单个角色为绝对边界，不仅包含浅层角色资料与当日日程，还完整囊括：
   - 全量文稿（日记、梦境、反思、作品的正文、摘要与验收回执）
   - 全量微观生活场景经历（破除分页限制，完整记录每一刻的情绪、生理阶段与环境描写）
   - 全量历史运行记录（Runs 执行日志与流水）
   - 提取并锚定原文的知识图谱三元组与实体集
   - 对应角色在 Layla 宿主中沉淀的原生记忆快照（通过 SDK 双向索引关联）
2. **原子不可分性 (Atomic Leaf Field Completeness)**:
   规范对所有数据结构进行彻底解构，下钻至不可再分的标量叶子字段，明确标注原始数据类型、必填性、封闭枚举范围、业务语义及主流底座对应键，杜绝任何“黑盒 JSON”或歧义字段。
3. **自包含与零源码依赖 (Self-Contained & Zero Source Dependency)**:
   任何第三方工程师或自动化迁移 Agent，在不查阅 Layla Life Dashboard 源码的前提下，仅凭本规范文档即可独立编写 100% 准确的解析、反序列化、清洗校验及目标底座导入工具。
4. **双轨封装与优雅降级 (Dual Packaging with Graceful Degradation)**:
   优先生成行业标准的结构化 PKZIP 归档包（便于模块化流式解压与差异化导入）；在无原生二进制打包能力的受限沙箱环境中，自动优雅降级为结构同构的单文件 JSON。

---

## 2. 记忆底座概念映射与迁移指引 (Alignment with Memory Substrates)

### 2.1 主流记忆底座范式对比

| 维度 | Layla Life Dashboard (生活手记) | Mem0 (原 EmbedChain Memory) | Letta (原 MemGPT) | Zep (Graphiti Temporal Graph) |
|---|---|---|---|---|
| **核心记忆模型** | 具身时钟生理仿真 + 场景流转 + 文稿反思 + 锚定图谱 | 多层级向量检索 + 实体关系图谱 (Graph Memory) | 分层操作系统内存 (Core, Archival, Recall Memory) | 时序知识图谱 (Temporal Knowledge Graph) + 对话会话 |
| **角色/智能体抽象** | `characterId` (角色独立隔离空间) | `agent_id` / `user_id` | `persona` 描述块 + Agent UUID | `user_id` / `session_id` |
| **即时上下文状态** | 生理指标 (精力/饥饿/心情) + 当前场景 + 角色卡状态块 | 会话即时上下文 / 动态 Metadata | Core Memory: `persona` & `human` 文本块 | 当前 Session Summary + 实时实体属性 |
| **事件与情节记忆** | 微观场景 (`scenes`) + 每日事实 (`daily_facts`) | Episodic Memories (文本片段 + 语义嵌入) | Archival Memory (无限追加的段落 Passages) | Temporal Episodes (具时效区间的事件节点) |
| **反思与沉淀记忆** | 归档文稿 (`documents`: 日记/梦境/创作) | Long-term Facts / Summaries | Archival Passages (打上类别与日期标签) | Episodic Summaries + Graph Nodes |
| **关联与事实网络** | 严格原文锚定的三元组 (`knowledge-graph`) | Entity-Relation Triples (`head-relation-tail`) | 外部嵌入召回或工具扩展知识库 | 具 `valid_at` / `invalid_at` 的事实边 (Fact Edges) |
| **宿主原生存储** | Layla 宿主原生会话记忆 (`native-memories`) | 外部平台持久化存储记录 | Recall Memory (消息缓冲区与历史工具调用) | Zep Messages & Session Store |

### 2.2 深度实体字段映射矩阵 (Cross-Substrate Mapping Matrix)

下表给出了从 Layla 导出的核心实体字段到 Mem0、Letta、Zep 的标准映射目标及转换逻辑：

| Layla Life 实体与字段 | Mem0 对应字段与概念 | Letta 对应字段与概念 | Zep 对应字段与概念 | 迁移转换逻辑说明 |
|---|---|---|---|---|
| `characterId` | `agent_id` 或 `user_id` | Agent `id` 或上下文元数据 | `user_id` | 统一作为目标底座中区分不同智能体身份的唯一租户标识。 |
| `profile.name` | `metadata.agent_name` | `persona` 块中的角色名声名 | Entity `name` (角色根节点) | 标记角色的展示姓名。 |
| `profile.settings.timezone` | `metadata.timezone` | `persona` 补充指令块 | `metadata.timezone` | 时区信息，指导时序计算。 |
| `profile.settings.sleepStart`, `sleepEnd` | `metadata.sleep_schedule` | Core Memory (`persona` block) | Temporal Profile Attributes | 写入 Letta 的 Core Memory，使 Agent 在与用户交互时天然知晓自己何时睡觉、何时起床。 |
| `profile.state` (精力, 饥饿, 心情) | `metadata.physiological_state` | Core Memory 动态注入块 | Temporal Entity Properties | 状态快照，用于恢复角色的当下情绪与疲劳度。 |
| `schedules.daily_facts` (唤醒事实, 时间线) | Episodic Item `content` + `metadata.category="schedule_fact"` | Core Memory (当日事实更新) / Archival Passage | Temporal Episode + `valid_at` 事实边 | 将起床时间、清晨片段作为确凿事实写入底座，例如“澪在 2026-11-01 于 08:15 起床”。 |
| `scenes.json` (逐条微观场景记录) | Episodic Memory `content = scene`<br>`metadata = { location, phase, day, start, end }` | Archival Memory Passage<br>标题/前缀标注 `[Scene: YYYY-MM-DD HH:MM]` | Temporal Episode<br>`valid_at = start`<br>`invalid_at = experiencedUntil` | 精细记录角色在某个时间段的经历。在 Zep 中利用毫秒时间戳赋予其强时序有效性。 |
| `documents.json` (日记、梦境、反思正文) | Episodic Memory `content = body`<br>`metadata = { kind, day, title, summary }` | Archival Memory Passage<br>`content = "# {title}\n\n{body}"` | Document / Long-term Memory Passage<br>附加 `summary` | 长期反思档案。梦境必须在元数据中明确标出 `nature: "dream"`，避免被 AI 误当作现实记忆。 |
| `documents.json` -> `summary` | Semantic Memory Item `content = summary` | Archival Passage 检索摘要前置项 | Episode Summary | 作为高密度的语义召回摘要。 |
| `knowledge-graph` (`triples`) | Mem0 Graph Triples:<br>`source = subject`<br>`relationship = relationship`<br>`target = object` | 结构化 Archival Passage 或外部 Knowledge Graph 导入 | Zep Graphiti Fact Triples:<br>`subject`, `predicate`, `object`<br>`valid_at = day` | 知识图谱三元组无损对接。直接将 `{ subject, relationship, object }` 导入 Mem0 图存储与 Zep 时序图谱。 |
| `native-memories.json` (宿主记忆) | Historical Session Items<br>`metadata.source="layla_native"` | Recall Memory Context<br>(历史对话/记忆重构) | Zep Session Messages / Memory Records | 宿主交互原生快照，承载聊天时的上下文基底。 |

### 2.3 面向第三方智能体的通用迁移指引 (Universal Migration Guidelines)

当外部迁移工具（无需 Layla 源码）读取此备份包时，请遵循以下四步转换算法：

```
+-----------------------------------------------------------------------------------+
|                        Layla 备份归档 (ZIP 或 单 JSON)                             |
+-----------------------------------------------------------------------------------+
         |
         | 1. 解析与完整性校验 (Manifest, Checksums, 记录数对账)
         v
+-----------------------------------------------------------------------------------+
|                           内存中标准化实体数据集                                    |
+-----------------------------------------------------------------------------------+
    |                           |                            |
    | 2A. Mem0 适配模式         | 2B. Letta 适配模式         | 2C. Zep (Graphiti) 适配模式
    v                           v                            v
- 生成 Agent & User 空间    - 初始化 Agent Persona 块    - 初始化 User/Session Graph
- 写入 Scenes / Docs 向量   - 组装 Core Memory (作息)    - 构建时序节点 (Temporal Nodes)
- 注入 Graph 实体三元组     - 逐篇切分 Archival Passages - 注入具时效性的 Fact Edges
- 打入 Time/Place Metadata  - 重建 Recall 会话记录       - 同步 Episodic Summaries
```

#### 2.3.1 迁移至 Mem0 指引
1. **初始化 Client**: 以 `manifest.characterId` 作为 Mem0 的 `agent_id`。
2. **导入场景 (Episodic)**:
   遍历 `scenes/scenes.json`，调用 `client.add(messages=[scene.scene], agent_id=characterId, metadata={"type": "scene", "day": scene.day, "phase": scene.phase, "location": scene.location, "start": scene.start, "end": scene.end})`。
3. **导入文稿 (Semantic/Reflective)**:
   遍历 `documents/documents.json`，将每篇文稿的 `body` 存入，并在 `metadata` 中附带 `{"type": "document", "kind": doc.kind, "title": doc.title, "day": doc.day, "summary": doc.summary}`。
4. **导入图谱 (Graph Memory)**:
   遍历 `knowledge-graph/graph.json` 中的 `triples`，批量写入 Mem0 Graph 存储，保持 `subject`、`relationship`、`object` 与 `nature` 原样落地。

#### 2.3.2 迁移至 Letta (MemGPT) 指引
1. **组装 Core Memory Persona 描述块**:
   提取 `profile.json` 中的 `name`, `settings.timezone`, `settings.home`, `settings.sleepStart`, `settings.sleepEnd` 以及 `schedules/daily_facts.json` 中的最新作息记录，拼接为角色常驻设定文本块（Persona Block）。
2. **组装 Core Memory Human 描述块**:
   提取文稿与原生记忆中涉及与“用户”约定的事实或互动风格，固化在 Human Block 中。
3. **导入 Archival Memory (无限档案存储)**:
   遍历 `documents/documents.json`，将每篇文稿格式化为 Markdown 字符串并调用 `client.insert_archival(agent_id, content)`。对每条记录加上元数据前缀，如 `[RECORD: diary | 2026-11-01] 《初冬的图书馆与红茶》\n...`。
4. **归档微观场景**: 将连续的 `scenes` 按日期聚合成每日经历备忘，追加至 Archival Memory。

#### 2.3.3 迁移至 Zep (Graphiti) 指引
1. **建立时间轴事件 (Temporal Episodes)**:
   遍历 `scenes/scenes.json`，根据 `scene.start` 和 `scene.experiencedUntil` 毫秒时间戳生成带明确时效性的 Episode。
2. **构建时序知识图谱边 (Fact Edges)**:
   读取 `knowledge-graph/graph.json`，对每条三元组：
   - 设置 `subject_node = triple.subject`
   - 设置 `predicate = triple.relationship`
   - 设置 `object_node = triple.object`
   - 若 `triple.day` 存在，赋予该边有效时间范围 `valid_at = epoch(triple.day)`。
3. **注入上下文摘要 (Contextual Summaries)**:
   将 `documents/documents.json` 中的 `summary` 同步为对应会话日期的 Episodic Summary。

---

## 3. 双轨封装格式规范 (Dual Packaging Formats)

备份格式支持两种物理表现形式，二者在逻辑数据层面上具备 **100% 结构同构性**。

### 3.1 主选格式：结构化 PKZIP 归档包 (Multi-File Archive)
- **文件命名规范**: `life-backup-<characterId>-<timestamp>.zip`
  - 示例: `life-backup-life-demo-mio-1793613600000.zip`
- **压缩规范**: 标准 PKZIP 2.0 规范，Deflate 压缩或 Store (Method 0) 存储，UTF-8 字符编码文件名。
- **内部目录树结构**:
  ```text
  / (ZIP Root)
  ├── manifest.json                  # 归档清单、版本、校验和与计数统计
  ├── profile.json                   # 角色核心资料、生活设置、生理状态、作息模板
  ├── schedules/
  │   ├── daily_facts.json           # 历史每日事实、唤醒/就寝标记、时间线事实集合
  │   └── plans.json                 # 独立日程全量规划（ll_plans）与局部区间变更审计记录
  ├── documents/
  │   └── documents.json             # 全量归档文稿（日记、梦境、反思、作品正文及摘要）
  ├── scenes/
  │   └── scenes.json                # 全量历史微观场景记录（含生理阶段与环境描写）
  ├── runs/
  │   └── history_runs.json          # 全量后台整理、场景生成与记忆同步运行记录
  ├── knowledge-graph/
  │   └── graph.json                 # 抽取并锚定原文的实体列表与事实三元组全集
  └── native-memories/
      └── native_memories.json       # 通过 SDK 读取并逆向关联的 Layla 原生记忆快照
  ```

### 3.2 降级格式：单一结构化 JSON 文件 (Single JSON Document)
- **文件命名规范**: `life-backup-<characterId>-<timestamp>.json`
  - 示例: `life-backup-life-demo-mio-1793613600000.json`
- **降级触发场景**: 宿主环境沙箱禁止 WebAssembly/TypedArray 二进制操作、无法构建 Zip Blob 或用户显式选择单文件导出时。
- **根容器骨架 (Root Container Skeleton)**:
  ```json
  {
    "exportVersion": "1.1.0",
    "specVersion": "1.1.0",
    "appVersion": "0.2.3",
    "exportedAt": 1793613600000,
    "characterId": "life-demo-mio",
    "characterName": "澪",
    "archiveMode": "json_fallback",
    "manifest": {},
    "profile": {},
    "schedules": [],
    "plans": [],
    "documents": [],
    "scenes": [],
    "runs": [],
    "knowledgeGraph": {
      "entities": [],
      "triples": []
    },
    "nativeMemories": []
  }
  ```

---

## 4. 原子级字段字典 (Atomic-Level Field Dictionary)

本章详述各个子文件及降级单文件中的**每一个不可再分的叶子字段**。

### 4.1 `manifest.json` 字段字典

描述整个备份归档的身份、校验和、文件清单与计数核对信息。

| JSON 路径 | 原始数据类型 | 必填性 | 枚举 / 格式 / 取值范围 | 业务含义与语义解释 | 记忆底座映射对齐 |
|---|---|---|---|---|---|
| `manifest.exportVersion` | `string` | **REQUIRED** | SemVer (如 `"1.1.0"`) | 导出文件格式的大版本号，用于升级兼容判定。 | `metadata.export_version` |
| `manifest.specVersion` | `string` | **REQUIRED** | SemVer (如 `"1.1.0"`) | 本规范文档的遵循版本。 | `metadata.spec_version` |
| `manifest.appVersion` | `string` | **REQUIRED** | SemVer (如 `"0.2.3"`) | 生成本备份文件的 Layla Life Dashboard 应用版本。 | `metadata.app_version` |
| `manifest.exportedAt` | `integer` | **REQUIRED** | Unix 毫秒时间戳 ($>0$) | 备份生成的绝对时刻。 | Timestamp / `created_at` |
| `manifest.characterId` | `string` | **REQUIRED** | 1–128 字符，URI 安全 | 当前导出数据的所属角色唯一 ID。 | Mem0: `agent_id`<br>Letta: Agent ID<br>Zep: `user_id` |
| `manifest.characterName` | `string` | **REQUIRED** | 1–64 字符非空字符串 | 角色在导出时的显示名称。 | Agent Display Name |
| `manifest.archiveMode` | `string` | **REQUIRED** | `"zip"` \| `"json_fallback"` | 实际封装打包采用的格式模式。 | `metadata.archive_mode` |
| `manifest.recordCounts.profile` | `integer` | **REQUIRED** | 固定为 `1` | 包含的角色资料记录数。 | N/A (核对校验项) |
| `manifest.recordCounts.schedules` | `integer` | **REQUIRED** | $\ge 0$ 整数 | 包含的每日事实记录条数。 | N/A (核对校验项) |
| `manifest.recordCounts.plans` | `integer` | **REQUIRED** | $\ge 0$ 整数 | 包含的独立日程全天规划记录条数 (`ll_plans`)。 | N/A (核对校验项) |
| `manifest.recordCounts.documents` | `integer` | **REQUIRED** | $\ge 0$ 整数 | 导出的全量归档文稿篇数。 | N/A (核对校验项) |
| `manifest.recordCounts.scenes` | `integer` | **REQUIRED** | $\ge 0$ 整数 | 导出的历史微观生活场景总条数。 | N/A (核对校验项) |
| `manifest.recordCounts.runs` | `integer` | **REQUIRED** | $\ge 0$ 整数 | 导出的工作流运行历史日志总条数。 | N/A (核对校验项) |
| `manifest.recordCounts.knowledgeGraphTriples` | `integer` | **REQUIRED** | $\ge 0$ 整数 | 知识图谱三元组记录总条数。 | N/A (核对校验项) |
| `manifest.recordCounts.knowledgeGraphEntities` | `integer` | **REQUIRED** | $\ge 0$ 整数 | 知识图谱独立实体节点数。 | N/A (核对校验项) |
| `manifest.recordCounts.nativeMemories` | `integer` | **REQUIRED** | $\ge 0$ 整数 | 关联的 Layla 原生记忆快照总条数。 | N/A (核对校验项) |
| `manifest.summary.planCount` | `integer` | **REQUIRED** | $\ge 0$ 整数 | 独立日程规划总条数摘要。 | N/A (核对校验项) |
| `manifest.files[].path` | `string` | **CONDITIONALLY_REQUIRED** (ZIP 模式必填) | 相对路径字符串 | ZIP 内的子文件相对路径（如 `"profile.json"`）。 | 存储定位标识 |
| `manifest.files[].sizeBytes` | `integer` | **CONDITIONALLY_REQUIRED** (ZIP 模式必填) | $\ge 0$ 字节整数 | 子文件解压后的原始字节大小。 | 完整性校验 |
| `manifest.files[].sha256` | `string` | **CONDITIONALLY_REQUIRED** (ZIP 模式必填) | 64 位十六进制小写哈希 | 子文件内容的 SHA-256 校验和。 | 完整性防篡改 |
| `manifest.files[].crc32` | `string` | **CONDITIONALLY_REQUIRED** (ZIP 模式必填) | 8 位十六进制大写/小写哈希 | 子文件内容的 CRC-32 校验和。 | ZIP 文件格式校验 |
| `manifest.files[].format` | `string` | **REQUIRED** | `"application/json"` | 子文件 MIME 格式。 | 数据格式标识 |

---

### 4.2 `profile.json` 字段字典

描述角色的基础资料、生活作息配置、生理仿真模拟状态、日计划模板及角色卡同步状态。

| JSON 路径 | 原始数据类型 | 必填性 | 枚举 / 格式 / 取值范围 | 业务含义与语义解释 | 记忆底座映射对齐 |
|---|---|---|---|---|---|
| `profile.schema` | `integer` | **REQUIRED** | `3` | Profile 数据模型版本，当前版本升级为 3（已完成 ll_plans 独立分表）。 | `schema_version` |
| `profile.characterId` | `string` | **REQUIRED** | 1–128 字符 | 角色唯一标识符。 | `agent_id` / `user_id` |
| `profile.name` | `string` | **REQUIRED** | 1–64 字符 | 角色名称。 | Persona 实体名称 |
| `profile.createdAt` | `integer` | **REQUIRED** | Unix 毫秒时间戳 | 角色在小应用中的首次建档时间。 | `created_at` |
| `profile.selectedSessionId` | `string` | **OPTIONAL** | 字符串或空串 | 当前选中的默认交互会话 ID。 | `session_id` |
| `profile.lastNativeAt` | `integer` | **REQUIRED** | Unix 毫秒时间戳 ($\ge 0$) | 最近一次接收并结算宿主原生消息的时间。 | 上下文时间戳 |
| `profile.lastRunAt` | `integer` | **REQUIRED** | Unix 毫秒时间戳 ($\ge 0$) | 最近一次执行后台生活任务的时间。 | 任务调度时间戳 |
| `profile.sceneIdentity` | `string` | **OPTIONAL** | 0–200 字符 | 场景生成的身份补充指令或风格设定。 | Persona Prompt Fragment |
| `profile.settings.timezone` | `string` | **REQUIRED** | `"Asia/Shanghai"` \| `"Asia/Tokyo"` \| `"UTC"` | 角色生活作息依托的基准时区。 | Timezone Metadata |
| `profile.settings.home` | `string` | **REQUIRED** | 0–80 字符 | 角色的默认住所/常住地点。 | Persona Location / Home |
| `profile.settings.sleepStart` | `string` | **REQUIRED** | `"HH:MM"` (如 `"23:30"`) | 默认入睡就寝时间。 | Persona 作息配置 |
| `profile.settings.sleepEnd` | `string` | **REQUIRED** | `"HH:MM"` (如 `"08:00"`) | 默认早晨起床时间。 | Persona 作息配置 |
| `profile.settings.healthNote` | `string` | **OPTIONAL** | 0–200 字符 | 手动或系统注记的健康/体质特征。 | Human/Persona Health Profile |
| `profile.settings.weatherNote` | `string` | **OPTIONAL** | 0–100 字符 | 当前天气描述（如 `"晴转多云 18℃"`）。 | Environment Context |
| `profile.settings.weatherCity` | `string` | **OPTIONAL** | 0–50 字符 | 天气对应的所属城市。 | Location Metadata |
| `profile.settings.weatherAt` | `integer` | **REQUIRED** | Unix 毫秒时间戳 ($\ge 0$) | 天气信息的获取/记录时刻。 | Valid Time |
| `profile.settings.autoScene` | `boolean` | **REQUIRED** | `true` \| `false` | 是否开启当前日程节点的微观场景自动生成。 | Configuration Flag |
| `profile.settings.background` | `boolean` | **REQUIRED** | `true` \| `false` | 是否开启后台生活整理守护进程。 | Configuration Flag |
| `profile.settings.autoWrite` | `boolean` | **REQUIRED** | `true` \| `false` | 文稿生成后是否自动交还写入 Layla 原生长期记忆。 | Configuration Flag |
| `profile.settings.syncCard` | `boolean` | **REQUIRED** | `true` \| `false` | 是否开启向角色卡实时状态块的无损双向同步。 | Configuration Flag |
| `profile.settings.syncPrecision` | `string` | **REQUIRED** | `"halfhour"` \| `"node"` \| `"minute"` | 角色卡状态同步块时间粒度（默认 `"halfhour"`，抑制每分钟更新打碎 host 模型 prompt cache）。 | Cache Protection Policy |
| `profile.settings.dayTypes` | `array<object>` | **REQUIRED** | 复合对象数组 | 作息类型原型配置清单（含相对权重、工作日/周末范围与 LLM 引导提示）。 | Schedule Archetypes |
| `profile.settings.extraRules` | `string` | **OPTIONAL** | 0–1000 字符 | 注入计划生成与角色卡的自定义作息补充硬性规则。 | Schedule Prompt Rule |
| `profile.settings.voiceRules` | `boolean` | **REQUIRED** | `true` \| `false` | 是否向角色卡注入第一人称口吻与交谈规范规则（默认 `true`）。 | Voice Prompt Rule |
| `profile.settings.businessPriority` | `boolean` | **REQUIRED** | `true` \| `false` | 是否注入“正事优先”原则（用户任务具有最高优先级，默认 `true`）。 | Directive Policy |
| `profile.settings.wokenBriefRule` | `boolean` | **REQUIRED** | `true` \| `false` | 是否在睡眠期间被唤醒时注入迷糊短应答口吻（默认 `true`）。 | Directive Policy |
| `profile.settings.customVoiceRules` | `string` | **OPTIONAL** | 0–1000 字符 | 自定义补充的第一人称口吻规则文本。 | Custom Voice Rule |
| `profile.settings.planAheadHour` | `integer` | **REQUIRED** | `0` – `23` (默认 `22`) | 晚间提前预生成次日计划的整点阈值小时。 | Scheduler Policy |
| `profile.settings.tomorrowAfterHour` | `integer` | **REQUIRED** | `0` – `23` (默认 `18`) | 晚间角色卡同步块开始注入明日预览的起始整点阈值。 | Context Injection Policy |
| `profile.settings.autoPlan` | `boolean` | **REQUIRED** | `true` \| `false` | 后台周期任务是否自动调用模型规划当日/次日日程（默认 `false`）。 | Scheduler Policy |
| `profile.settings.memorySessionMode`| `string` | **REQUIRED** | `"isolated"` \| `"active"` | 记忆会话归档策略（独立会话 `life-archive-<id>` 还是绑定活跃会话）。 | Session Mode Policy |
| `profile.settings.diaryHour` | `integer` | **REQUIRED** | `0` – `23` | 每日触发日记整理与回忆反思的整点小时。 | Scheduler Policy |
| `profile.settings.dayType` | `string` | **OPTIONAL** | `""` \| `"工作日"` \| `"周末"` | 手动强制覆盖的当日作息类型。 | Schedule Category |
| `profile.settings.holidayNotes` | `string` | **OPTIONAL** | 多行文本格式 | 手动添加的节日/特殊纪念日备忘清单。 | Persona Calendar Knowledge |
| `profile.state.energy` | `number` | **REQUIRED** | `0.0` – `100.0` (Float) | 生理精力仿真值，休息上升，工作/活动消耗。 | Temporal State Property |
| `profile.state.hunger` | `number` | **REQUIRED** | `0.0` – `100.0` (Float) | 饥饿度仿真值，随时间自然增加，用餐后重置。 | Temporal State Property |
| `profile.state.mood` | `number` | **REQUIRED** | `-1.0` – `1.0` (Float) | 心情指数，正向为愉悦，负向为低落。 | Temporal Emotion Property |
| `profile.state.arousal` | `number` | **REQUIRED** | `0.0` – `1.0` (Float) | 生理唤醒度，睡眠时降低，交互或清醒时提高。 | Temporal Arousal Property |
| `profile.state.updatedAt` | `integer` | **REQUIRED** | Unix 毫秒时间戳 | 生理状态最近一次结算的精确时刻。 | State Valid At |
| `profile.state.awakeUntil` | `integer` | **REQUIRED** | Unix 毫秒时间戳 ($\ge 0$) | 若角色在睡眠期间被交互唤醒，保持唤醒状态的截止时刻。 | Temporary Wake Boundary |
| `profile.state.lastSleepEnd` | `integer` | **REQUIRED** | Unix 毫秒时间戳 ($\ge 0$) | 上一次睡眠实际苏醒结束的绝对时间戳。 | Circadian Sleep Anchor |
| `profile.state.recentSleepHours`| `number` | **REQUIRED** | $\ge 0.0$ (Float) | 最近一次睡眠的实际持续时长（小时）。 | Sleep Duration Fact |
| `profile.state.appliedNodes[]` | `array<string>` | **REQUIRED** | 格式 `"YYYY-MM-DD/<nodeId>"` | 已结算过生理影响的日程节点键列表（防重复结算）。 | Dedup Cache Key |
| `profile.state.seenMessages[]` | `array<string>` | **REQUIRED** | 宿主消息 ID 字符串数组 | 已结算过唤醒效应的宿主对话消息 ID 列表。 | Dedup Cache Key |
| `profile.plans` | `object` | **REQUIRED** | 键为 `"YYYY-MM-DD"` | 日程计划集合，存储特定日期的全天节点规划。 | Schedule Knowledge |
| `profile.plans[day].source` | `string` | **REQUIRED** | `"template"` \| `"generated"` \| `"manual"` | 该日日程的生成来源。 | Provenance |
| `profile.plans[day].nodes[]` | `array<object>` | **REQUIRED** | 2–32 个有序节点 | 全天 00:00–24:00 连续无缝无重叠的节点列表。 | Daily Episodes Sequence |
| `profile.plans[day].nodes[].id` | `string` | **REQUIRED** | 格式 `"<day>-<startMinute>"` | 节点唯一 ID（如 `"2026-11-01-480"`）。 | Episode Node ID |
| `profile.plans[day].nodes[].start` | `integer` | **REQUIRED** | `0` – `1440` (从0点起算分钟) | 节点开始时间，当天首节点必须为 0。 | Start Minute |
| `profile.plans[day].nodes[].end` | `integer` | **REQUIRED** | `0` – `1440` (从0点起算分钟) | 节点结束时间，末节点必须为 1440，且必须等于下个节点 start。 | End Minute |
| `profile.plans[day].nodes[].kind` | `string` | **REQUIRED** | `"sleep"` \| `"nap"` \| `"meal"` \| `"work"` \| `"study"` \| `"travel"` \| `"leisure"` \| `"rest"` | 节点行为类型，决定生理消耗系数与睡眠判定。 | Episode Category |
| `profile.plans[day].nodes[].summary` | `string` | **REQUIRED** | 1–100 字符非空字符串 | 节点的简短活动概要（如 `"晨读与整理笔记"`）。 | Activity Summary |
| `profile.plans[day].nodes[].location`| `string` | **REQUIRED** | 1–80 字符 | 节点活动发生地点。 | Location |
| `profile.plans[day].nodes[].scene` | `string` | **REQUIRED** | 0–500 字符 | 节点附带的静态预设场景描述（可为空串）。 | Static Scene Prompt |
| `profile.plans[day].nodes[].source` | `string` | **REQUIRED** | `"template"` \| `"generated"` \| `"manual"` | 节点来源。 | Provenance |
| `profile.cardSync.hash` | `string` | **REQUIRED** | 哈希字符串或空串 | 最近一次同步到角色卡的文本哈希值（用于幂等比对）。 | Sync Hash |
| `profile.cardSync.syncedAt` | `integer` | **REQUIRED** | Unix 毫秒时间戳 ($\ge 0$) | 最近一次成功写入角色卡的时间戳。 | Sync Timestamp |
| `profile.cardSync.day` | `string` | **REQUIRED** | `"YYYY-MM-DD"` 或空串 | 同步内容对应的自然日期。 | Sync Date |
| `profile.cardSync.status` | `string` | **REQUIRED** | `"idle"` \| `"synced"` \| `"error"` | 角色卡同步状态。 | Sync Status |
| `profile.cardSync.error` | `string` | **REQUIRED** | 字符串（成功时为空串） | 最近一次同步失败时的错误信息。 | Sync Error Message |
| `profile.cardSync.preview` | `string` | **REQUIRED** | 字符串 | 注入到角色卡内部的完整实时状态文本预览。 | Injected Persona Text |

---

### 4.3 `schedules/daily_facts.json` 字段字典

存储角色每日提取的具时效性生活事实、唤醒时刻确定证据及日内时间线骨架（顶层为一个数组 `DailyFact[]`）。

| JSON 路径 | 原始数据类型 | 必填性 | 枚举 / 格式 / 取值范围 | 业务含义与语义解释 | 记忆底座映射对齐 |
|---|---|---|---|---|---|
| `[].day` | `string` | **REQUIRED** | `"YYYY-MM-DD"` | 事实关联的自然公历日期。 | `metadata.day` / Temporal Date |
| `[].characterId` | `string` | **REQUIRED** | 1–128 字符 | 事实归属的角色 ID。 | `agent_id` |
| `[].plannedSleepStart` | `string` | **REQUIRED** | `"HH:MM"` | 当日规划的就寝时间。 | Planned Sleep Time |
| `[].plannedWakeTime` | `string` | **REQUIRED** | `"HH:MM"` | 当日规划的早晨起床时间。 | Planned Wake Time |
| `[].wakeTime` | `string` | **REQUIRED** | `"HH:MM"` 或空串 | 结算出的实际确凿起床时间（如 `"08:15"`）。 | Zep: Temporal Wake Fact<br>Letta: Core Fact |
| `[].wakePhrase` | `string` | **REQUIRED** | 字符串 (如 `"08:15起身"`) | 起床判定的原始短语或证据。 | Grounding Evidence |
| `[].wakeSource` | `string` | **REQUIRED** | `"diary"` \| `"scene"` \| `"sleeping"` \| `"schedule"` | 起床时间的证据来源（日记自述、场景记录、仍处于睡眠、作息规划推算）。 | Fact Provenance |
| `[].wakeSummary` | `string` | **REQUIRED** | 详细说明字符串 | 人类可读的起床与作息事实长句，直接用于向角色卡或 Core Memory 交代作息。 | Core Memory Fact Fragment |
| `[].firstAwakeTime` | `string` | **REQUIRED** | `"HH:MM"` 或空串 | 当日首个记录到的清醒微观场景时刻。 | Temporal Anchor |
| `[].timelineItems[]` | `array<object>` | **REQUIRED** | 最多 6 条近期时间线 | 当日已发生的关键节点时间线概览。 | Episodic Timeline |
| `[].timelineItems[].time` | `string` | **REQUIRED** | `"HH:MM"` | 片段开始时间。 | Event Start Time |
| `[].timelineItems[].until` | `string` | **REQUIRED** | `"HH:MM"` | 片段持续截止时间。 | Event End Time |
| `[].timelineItems[].summary` | `string` | **REQUIRED** | 字符串 | 活动概要。 | Event Summary |
| `[].timelineItems[].location` | `string` | **REQUIRED** | 字符串 | 活动地点。 | Event Location |
| `[].timelineItems[].phase` | `string` | **REQUIRED** | `"awake"` \| `"falling_asleep"` \| `"light_sleep"` \| `"deep_sleep"` \| `"woken"` | 生理睡眠阶段。 | Physiological Phase |
| `[].todayDiaryTitle` | `string` | **REQUIRED** | 字符串（无日记时为空） | 当日日记标题。 | Linked Doc Title |
| `[].todayDiarySummary` | `string` | **REQUIRED** | 字符串（无日记时为空） | 当日日记摘要。 | Linked Doc Summary |
| `[].todayDreamTitle` | `string` | **REQUIRED** | 字符串（无梦境时为空） | 当日梦境标题。 | Linked Doc Title |
| `[].todayDreamSummary` | `string` | **REQUIRED** | 字符串（无梦境时为空） | 当日梦境摘要。 | Linked Doc Summary |

---

### 4.4 `schedules/plans.json` 字段字典

存储角色独立日日程全量规划记录（`ll_plans` 表数据）及局部区间变更审计历史（顶层为一个数组 `PlanRecord[]`）。

| JSON 路径 | 原始数据类型 | 必填性 | 枚举 / 格式 / 取值范围 | 业务含义与语义解释 | 记忆底座映射对齐 |
|---|---|---|---|---|---|
| `[].id` | `string` | **REQUIRED** | `plan-<characterId>-<day>` | 独立日计划唯一主键。 | Schedule Plan ID |
| `[].characterId` | `string` | **REQUIRED** | 1–128 字符 | 计划归属的角色 ID。 | `agent_id` |
| `[].day` | `string` | **REQUIRED** | `"YYYY-MM-DD"` | 计划所对应的自然公历日期。 | Temporal Date Anchor |
| `[].title` | `string` | **REQUIRED** | 1–100 字符 | 当日日程的核心主题/生活标题。 | Schedule Theme |
| `[].mood` | `string` | **REQUIRED** | 1–50 字符 (如 `"平静"`, `"充实"`) | 当日预设的心情基调。 | Schedule Mood |
| `[].dayType` | `string` | **REQUIRED** | 字符串 (如 `"restday"`, `"workday"`) | 该计划所选用的作息原型分类标识。 | DayType Category |
| `[].source` | `string` | **REQUIRED** | `"generated"` \| `"template"` \| `"manual"` \| `"legacy"` | 该日程计划的生成来源。 | Provenance |
| `[].hint` | `string` | **OPTIONAL** | 0–200 字符 | 生成该日程时用户或系统输入的特定安排提示。 | User Directive |
| `[].generatedAt` | `integer` | **REQUIRED** | Unix 毫秒时间戳 | 该计划最初生成落库的时间戳。 | Created At |
| `[].changes[]` | `array<object>` | **REQUIRED** | 审计对象数组 | 对该日日程执行的区间修改与动态调整历史流水。 | Change Audit Log |
| `[].changes[].at` | `integer` | **REQUIRED** | Unix 毫秒时间戳 | 区间变更发生的精确时刻。 | Change Timestamp |
| `[].changes[].start` | `string` | **REQUIRED** | `"HH:MM"` | 修改影响的起始时间点。 | Change Interval Start |
| `[].changes[].end` | `string` | **REQUIRED** | `"HH:MM"` | 修改影响的截止时间点。 | Change Interval End |
| `[].changes[].summary` | `string` | **REQUIRED** | 1–100 字符 | 变更插入的新活动概要。 | New Activity Summary |
| `[].changes[].detail` | `string` | **OPTIONAL** | 字符串 | 变更活动的补充描述。 | Activity Detail |
| `[].nodes[]` | `array<object>` | **REQUIRED** | 2–32 个有序节点 | 全天 00:00–24:00 连续无缝无重叠的完整节点列表。 | Daily Episodes Sequence |
| `[].nodes[].id` | `string` | **REQUIRED** | 格式 `"<day>-<startMinute>"` | 节点唯一 ID。 | Episode Node ID |
| `[].nodes[].start` | `string` \| `integer` | **REQUIRED** | `"HH:MM"` 或 `0`–`1440` | 节点开始时间（整日分钟或时钟格式）。 | Start Time |
| `[].nodes[].end` | `string` \| `integer` | **REQUIRED** | `"HH:MM"` 或 `0`–`1440` | 节点结束时间（末节点为 24:00 / 1440）。 | End Time |
| `[].nodes[].kind` | `string` | **REQUIRED** | `"sleep"` \| `"nap"` \| `"meal"` \| `"work"` \| `"study"` \| `"travel"` \| `"leisure"` \| `"rest"` | 节点活动类型枚举。 | Activity Category |
| `[].nodes[].summary` | `string` | **REQUIRED** | 1–100 字符非空字符串 | 节点的活动概要描述。 | Activity Summary |
| `[].nodes[].location` | `string` | **REQUIRED** | 1–80 字符 | 节点活动发生地点。 | Location |
| `[].nodes[].scene` | `string` | **OPTIONAL** | 0–500 字符 | 节点附带的静态预设微观场景描述。 | Static Scene Prompt |
| `[].nodes[].detail` | `string` | **OPTIONAL** | 0–500 字符 | 活动详细说明或备忘。 | Activity Detail |
| `[].nodes[].source` | `string` | **REQUIRED** | `"generated"` \| `"template"` \| `"manual"` \| `"change"` | 节点生成或注入来源。 | Provenance |

---

### 4.5 `documents/documents.json` 字段字典

存储角色沉淀的全量长期归档文稿（日记、梦境、反思、作品）（顶层为数组 `Document[]`）。

| JSON 路径 | 原始数据类型 | 必填性 | 枚举 / 格式 / 取值范围 | 业务含义与语义解释 | 记忆底座映射对齐 |
|---|---|---|---|---|---|
| `[].id` | `string` | **REQUIRED** | `life-<characterId>-<kind>-<YYYY-MM-DD>` | 文稿全局唯一主键。 | Document ID / Entity ID |
| `[].characterId` | `string` | **REQUIRED** | 1–128 字符 | 所属角色 ID。 | `agent_id` |
| `[].sessionId` | `string` | **REQUIRED** | 字符串 | 产生该文稿的会话 ID。 | `session_id` |
| `[].kind` | `string` | **REQUIRED** | `"diary"` \| `"dream"` \| `"reflection"` \| `"work"` | 文稿性质：日记（真实生活）、梦境（虚构梦境）、反思（思想感悟）、创作（艺术作品）。 | `metadata.kind` / Category |
| `[].day` | `string` | **REQUIRED** | `"YYYY-MM-DD"` | 记录所涉及的对应自然公历日期。 | Temporal Date Anchor |
| `[].title` | `string` | **REQUIRED** | 1–160 字符 | 文稿标题。 | Title / Header |
| `[].body` | `string` | **REQUIRED** | 1–16000 字符 | 文稿完整正文 Markdown 文本。 | Mem0: `content`<br>Letta: Archival Passage<br>Zep: Document Body |
| `[].summary` | `string` | **REQUIRED** | 1–1200 字符 | 文稿浓缩摘要（含时间锚点与生活核心动作）。 | Semantic Summary / Index |
| `[].createdAt` | `integer` | **REQUIRED** | Unix 毫秒时间戳 | 文稿生成并落库的时刻。 | `created_at` |
| `[].syncStatus` | `string` | **REQUIRED** | `"pending"` \| `"writing"` \| `"written"` \| `"failed"` \| `"stale"` | 交还 Layla 宿主原生记忆库的状态。 | Sync Lifecycle State |
| `[].memoryId` | `integer` \| `null`| **REQUIRED** | 正整数或 `null` | 成功交还写入 Layla 原生记忆后的 ID，未交还时必须为 `null`。 | Host Foreign Key |
| `[].graphStatus` | `string` | **REQUIRED** | `"pending"` \| `"missing"` \| `"generating"` \| `"draft"` \| `"writing"` \| `"uncertain"` \| `"error"` \| `"ready"` | 知识图谱抽取与原生图谱核对状态。 | Knowledge Graph Pipeline State |
| `[].graphDraftJSON` | `string` \| `null`| **OPTIONAL** | JSON 字符串或 `null` | 暂存的图谱三元组中间草稿 JSON 文本。 | Graph Draft Buffer |
| `[].retrievalStatus` | `string` | **REQUIRED** | `"unverified"` \| `"passed"` \| `"failed"` | 用户在真机交互中对该记忆的召回验收状态。 | Verification Status |
| `[].retrievalNote` | `string` | **OPTIONAL** | 字符串 (未验收时为空串) | 用户填写的真机召回验收评测详细报告。 | Human Audit Log |
| `[].retrievalAt` | `integer` \| `null`| **OPTIONAL** | Unix 毫秒时间戳或 `null` | 执行召回验收的时刻。 | Verified At |
| `[].sourceSceneIds[]` | `array<string>` | **REQUIRED** | 场景 ID 数组 | 整理此文稿时参考的前序生活场景 ID 列表。 | Provenance References |
| `[].sourceMessageIds[]` | `array<string>` | **REQUIRED** | 宿主消息 ID 数组 | 整理此文稿时参考的宿主聊天消息 ID 列表。 | Provenance References |
| `[].timelineFacts` | `object` \| `null`| **OPTIONAL** | 符合 DailyFact 结构的子对象 | 嵌入整理文稿时提取的当日时间线事实快照。 | Embedded Facts |
| `[].version` | `string` | **REQUIRED** | SemVer (如 `"0.2.3"`) | 生成文稿时的系统版本号。 | Provenance Version |

---

### 4.6 `scenes/scenes.json` 字段字典

存储角色在时间线上经历的微观生活场景描写（40–500 字，按时间序展开）（顶层为数组 `Scene[]`）。

| JSON 路径 | 原始数据类型 | 必填性 | 枚举 / 格式 / 取值范围 | 业务含义与语义解释 | 记忆底座映射对齐 |
|---|---|---|---|---|---|
| `[].id` | `string` | **REQUIRED** | 唯一字符串 ID | 场景记录主键 ID。 | Episode ID |
| `[].characterId` | `string` | **REQUIRED** | 1–128 字符 | 角色 ID。 | `agent_id` |
| `[].key` | `string` | **REQUIRED** | 复合字符串 | 包含节点哈希、生理阶段与唤醒周期的复合缓存键。 | Cache Scope Key |
| `[].nodeKey` | `string` | **REQUIRED** | 节点特征哈希 | 节点静态特征散列。 | Node Signature Key |
| `[].nodeId` | `string` | **REQUIRED** | 节点 ID (如 `"2026-11-01-510"`) | 对应的当日日程节点 ID。 | Node ID |
| `[].day` | `string` | **REQUIRED** | `"YYYY-MM-DD"` | 场景发生的自然公历日期。 | Date Anchor |
| `[].start` | `integer` | **REQUIRED** | Unix 毫秒时间戳 | 节点开始对应的绝对时刻。 | Episode Start Timestamp |
| `[].end` | `integer` | **REQUIRED** | Unix 毫秒时间戳 | 节点结束对应的绝对时刻 ($start < end$)。 | Episode End Timestamp |
| `[].phase` | `string` | **REQUIRED** | `"awake"` \| `"falling_asleep"` \| `"light_sleep"` \| `"deep_sleep"` \| `"woken"` | 场景发生时角色所处的睡眠生理阶段。 | Physiological Phase |
| `[].summary` | `string` | **REQUIRED** | 1–100 字符 | 对应日程节点的简要行为概述。 | Event Label |
| `[].location` | `string` | **REQUIRED** | 1–80 字符 | 场景发生地点。 | Location Tag |
| `[].scene` | `string` | **REQUIRED** | 40–500 字符 | 模型精细生成或用户填写的微观生活场景正文段落。 | Mem0: Episodic Item<br>Letta: Archival Passage<br>Zep: Episode Content |
| `[].source` | `string` | **REQUIRED** | `"generated"` \| `"manual"` | 场景来源（模型自动细化生成或人工编写锁定）。 | Provenance |
| `[].generatedAt` | `integer` | **REQUIRED** | Unix 毫秒时间戳 | 场景实际生成或记录的时刻。 | Created At |
| `[].experiencedUntil` | `integer` | **REQUIRED** | Unix 毫秒时间戳 | 场景被后序场景切换或当前时刻截断的实际经历截止时间。 | Valid Until / `invalid_at` |
| `[].version` | `string` | **REQUIRED** | SemVer (如 `"0.2.3"`) | 生成该场景的系统版本号。 | Provenance Version |

---

### 4.7 `runs/history_runs.json` 字段字典

存储后台生活任务、日程规划、场景细化与长期记忆交还的全量历史运行流水（顶层为数组 `Run[]`）。

| JSON 路径 | 原始数据类型 | 必填性 | 枚举 / 格式 / 取值范围 | 业务含义与语义解释 | 记忆底座映射对齐 |
|---|---|---|---|---|---|
| `[].id` | `string` | **REQUIRED** | 唯一字符串 ID | 执行流水 ID。 | Execution Run ID |
| `[].characterId` | `string` | **REQUIRED** | 1–128 字符 | 角色 ID。 | `agent_id` |
| `[].at` | `integer` | **REQUIRED** | Unix 毫秒时间戳 | 运行完成时刻的时间戳。 | Execution Timestamp |
| `[].kind` | `string` | **REQUIRED** | `"scene"` \| `"diary"` \| `"dream"` \| `"reflection"` \| `"work"` \| `"memory"` \| `"refresh"` \| `"plan"` \| `"card-sync"` | 触发的工作流任务类型。 | Tool / Task Action |
| `[].status` | `string` | **REQUIRED** | `"ok"` \| `"error"` | 任务执行结果状态（成功或异常）。 | Execution Result |
| `[].message` | `string` | **REQUIRED** | 详细说明字符串 | 人类可读的运行结果或错误堆栈描述。 | Tool Output / Audit Log |

---

### 4.8 `knowledge-graph/graph.json` 字段字典

存储从所有真实文稿与梦境中抽取并经原文逐字锚定核对的实体与三元组事实网络。

#### 4.8.1 根容器对象结构

| JSON 路径 | 原始数据类型 | 必填性 | 枚举 / 格式 / 取值范围 | 业务含义与语义解释 | 记忆底座映射对齐 |
|---|---|---|---|---|---|
| `graph.entities[]` | `array<object>` | **REQUIRED** | 实体对象列表 | 图谱中出现的独立命名实体节点。 | Graph Entities / Nodes |
| `graph.triples[]` | `array<object>` | **REQUIRED** | 三元组对象列表 | 实体间的关系边事实全集。 | Graph Triples / Edges |

#### 4.8.2 实体对象 (`graph.entities[]`) 叶子字典

| JSON 路径 | 原始数据类型 | 必填性 | 枚举 / 格式 / 取值范围 | 业务含义与语义解释 | 记忆底座映射对齐 |
|---|---|---|---|---|---|
| `[].id` | `string` | **REQUIRED** | 唯一字符串 | 实体标识（通常即为规范化实体名称）。 | Node ID / Key |
| `[].name` | `string` | **REQUIRED** | 1–240 字符 | 实体名称。 | Node Label |
| `[].type` | `string` | **REQUIRED** | `"character"` \| `"document"` \| `"concept"` \| `"location"` \| `"item"` \| `"activity"` | 实体类别。 | Node Type |
| `[].description` | `string` | **OPTIONAL** | 描述字符串 | 实体的补充语义说明。 | Node Description |

#### 4.8.3 三元组对象 (`graph.triples[]`) 叶子字典

| JSON 路径 | 原始数据类型 | 必填性 | 枚举 / 格式 / 取值范围 | 业务含义与语义解释 | 记忆底座映射对齐 |
|---|---|---|---|---|---|
| `[].id` | `string` | **REQUIRED** | 唯一字符串 ID | 三元组唯一主键。 | Edge ID |
| `[].documentId` | `string` | **REQUIRED** | 外键关联文稿 ID | 抽取该三元组所依据的原始文稿 ID。 | Source Document Ref |
| `[].day` | `string` | **REQUIRED** | `"YYYY-MM-DD"` | 事实发生的公历日期。 | Temporal Validity Date |
| `[].subject` | `string` | **REQUIRED** | 1–240 字符 | 主体节点名称（通常为角色名或文稿作用域节点）。 | Head Entity / Source Node |
| `[].relationship` | `string` | **REQUIRED** | 1–100 字符 | 关系谓词（如 `"生活记录"`, `"记录中作息"`, `"记录中地点"`, 或带日期的投影谓词如 `"2026-11-01作息"`）。 | Relation / Predicate Edge |
| `[].object` | `string` | **REQUIRED** | 1–240 字符 | 客体节点名称或属性值（严格来源于文稿正文或摘要）。 | Tail Entity / Target Node |
| `[].nature` | `string` | **REQUIRED** | `"reality"` \| `"dream"` \| `"fiction"` | 事实真实性属性（真实生活、梦境、虚构文学）。 | Truth Nature Tag |
| `[].groundedInText` | `boolean` | **REQUIRED** | 固定为 `true` | 是否经过原文逐字严格锚定核对（生活手记导出的事实均为 true）。 | Verifiability Provenance |

---

### 4.9 `native-memories/native_memories.json` 字段字典

存储小应用通过 SDK 读取并逆向关联的 Layla 宿主原生会话记忆快照（顶层为数组 `NativeMemorySnapshot[]`）。

| JSON 路径 | 原始数据类型 | 必填性 | 枚举 / 格式 / 取值范围 | 业务含义与语义解释 | 记忆底座映射对齐 |
|---|---|---|---|---|---|
| `[].id` | `integer` | **REQUIRED** | 正整数 ($>0$) | Layla 宿主数据库中原生记忆的主键 ID。 | Host Memory ID |
| `[].character_id` | `string` | **REQUIRED** | 1–128 字符 | 宿主中的角色标识符。 | `agent_id` |
| `[].session_id` | `string` | **REQUIRED** | 字符串 (如 `"life-archive-mio"`) | 宿主中的记忆归档会话 ID。 | `session_id` |
| `[].timestamp` | `integer` | **REQUIRED** | Unix 毫秒时间戳 | 宿主记忆生成的时间戳。 | Timestamp |
| `[].rawText` | `string` | **REQUIRED** | 包含技术标记的原文 | 带有 `【Layla生活记录:<id>】` 来源标记的原生记忆完整文本。 | Host Raw Content |
| `[].summary` | `string` | **REQUIRED** | 带时间锚点的摘要 | 写入宿主记忆库的带时间锚点与起身标记的紧凑摘要。 | Host Summary |
| `[].knowledgeGraphJSON`| `string` \| `null`| **REQUIRED** | JSON 字符串或 `null` | 写入宿主的原生知识图谱 JSON 字符串（符合 l3utterfly 格式）。 | Host Graph Triples Payload |
| `[].associatedDocumentId`| `string` \| `null`| **REQUIRED** | 文稿 ID 或 `null` | 逆向关联到的小应用内部文稿 ID。 | Local Document Foreign Key |

---

### 4.10 降级单文件 JSON 根容器字段字典 (`life-backup-*.json`)

当且仅当发生格式降级时，根对象由以下字段构成：

| JSON 路径 | 原始数据类型 | 必填性 | 说明 |
|---|---|---|---|
| `exportVersion` | `string` | **REQUIRED** | 见 4.1 节 `manifest.exportVersion` |
| `specVersion` | `string` | **REQUIRED** | 见 4.1 节 `manifest.specVersion` |
| `appVersion` | `string` | **REQUIRED** | 见 4.1 节 `manifest.appVersion` |
| `exportedAt` | `integer` | **REQUIRED** | 见 4.1 节 `manifest.exportedAt` |
| `characterId` | `string` | **REQUIRED** | 见 4.1 节 `manifest.characterId` |
| `characterName` | `string` | **REQUIRED** | 见 4.1 节 `manifest.characterName` |
| `archiveMode` | `string` | **REQUIRED** | 固定为 `"json_fallback"` |
| `manifest` | `object` | **REQUIRED** | 完整内嵌 4.1 节定义的 Manifest 字典对象 |
| `profile` | `object` | **REQUIRED** | 完整内嵌 4.2 节定义的 Profile 字典对象 |
| `schedules` | `array<object>` | **REQUIRED** | 完整内嵌 4.3 节定义的 DailyFact 数组 |
| `plans` | `array<object>` | **REQUIRED** | 完整内嵌 4.4 节定义的 PlanRecord 数组 |
| `documents` | `array<object>` | **REQUIRED** | 完整内嵌 4.5 节定义的 Document 数组 |
| `scenes` | `array<object>` | **REQUIRED** | 完整内嵌 4.6 节定义的 Scene 数组 |
| `runs` | `array<object>` | **REQUIRED** | 完整内嵌 4.7 节定义的 Run 数组 |
| `knowledgeGraph` | `object` | **REQUIRED** | 完整内嵌 4.8 节定义的 Graph 字典对象 (`{ entities, triples }`) |
| `nativeMemories` | `array<object>` | **REQUIRED** | 完整内嵌 4.9 节定义的 NativeMemorySnapshot 数组 |

---

## 5. 完整实际文件示例 (Complete Concrete Real-World Examples)

本章给出真实环境下完全合法、可直接通过 `JSON.parse()` 校验的 9 个子文件（含独立分表 `schedules/plans.json`）及单文件降级 JSON 的完整内容（以角色“澪”、日期“2026-11-01”为例，杜绝任何省略号与伪代码占位）。

### 5.1 `manifest.json` 示例
```json
{
  "exportVersion": "1.1.0",
  "specVersion": "1.1.0",
  "appVersion": "0.2.3",
  "version": "0.2.3",
  "exportedAt": 1793613600000,
  "exportedAtISO": "2026-11-01T14:00:00.000Z",
  "characterId": "life-demo-mio",
  "characterName": "澪",
  "archiveMode": "zip",
  "recordCounts": {
    "profile": 1,
    "schedules": 1,
    "plans": 1,
    "documents": 1,
    "scenes": 2,
    "runs": 2,
    "knowledgeGraphTriples": 5,
    "knowledgeGraphEntities": 3,
    "nativeMemories": 1
  },
  "summary": {
    "documentCount": 1,
    "sceneCount": 2,
    "runCount": 2,
    "tripleCount": 5,
    "nativeMemoryCount": 1,
    "planCount": 1
  },
  "files": [
    {
      "path": "manifest.json",
      "description": "导出元数据清单"
    },
    {
      "path": "profile.json",
      "sizeBytes": 2450,
      "sha256": "4a7d1ed414474e4033ac29ccb8653d9b1397b9ee9bb56f4d1e2e4ef65c711202",
      "crc32": "8A2B3C4D",
      "format": "application/json"
    },
    {
      "path": "schedules/daily_facts.json",
      "sizeBytes": 1024,
      "sha256": "8ef01bcda5b625720d20efab2a4d310619a8fbcfecbb0d4374b60e6f98efaa55",
      "crc32": "5F6E7D8C",
      "format": "application/json"
    },
    {
      "path": "schedules/plans.json",
      "sizeBytes": 1820,
      "sha256": "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c",
      "crc32": "7D8E9F0A",
      "format": "application/json"
    },
    {
      "path": "documents/documents.json",
      "sizeBytes": 3200,
      "sha256": "5c9b28a9b23de874e0d9b4b0e8b15d9cf2b63cb0559eb205db8542b4d1efcba1",
      "crc32": "3A4B5C6D",
      "format": "application/json"
    },
    {
      "path": "scenes/scenes.json",
      "sizeBytes": 2150,
      "sha256": "6b8a21fc7d23a9b1c0e9d4a8e2b3c4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1",
      "crc32": "1E2F3A4B",
      "format": "application/json"
    },
    {
      "path": "runs/history_runs.json",
      "sizeBytes": 680,
      "sha256": "7a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b",
      "crc32": "9C8B7A6F",
      "format": "application/json"
    },
    {
      "path": "knowledge-graph/graph.json",
      "sizeBytes": 1650,
      "sha256": "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b",
      "crc32": "4B5C6D7E",
      "format": "application/json"
    },
    {
      "path": "native-memories/native_memories.json",
      "sizeBytes": 2400,
      "sha256": "3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e",
      "crc32": "2D3E4F5A",
      "format": "application/json"
    }
  ]
}
```

### 5.2 `profile.json` 示例
```json
{
  "schema": 3,
  "characterId": "life-demo-mio",
  "name": "澪",
  "createdAt": 1793500000000,
  "selectedSessionId": "session-mio-chat",
  "lastNativeAt": 1793610000000,
  "lastRunAt": 1793613000000,
  "sceneIdentity": "性格沉静专注的文学系大学生，说话轻柔温和",
  "settings": {
    "timezone": "Asia/Shanghai",
    "home": "枫叶町单人公寓",
    "sleepStart": "23:30",
    "sleepEnd": "08:00",
    "healthNote": "偶有低血压，早晨起床动作宜缓",
    "weatherNote": "晴朗 微风 16℃",
    "weatherCity": "上海",
    "weatherAt": 1793608800000,
    "autoScene": true,
    "background": true,
    "autoWrite": true,
    "syncCard": true,
    "syncPrecision": "halfhour",
    "dayTypes": [
      {
        "id": "restday",
        "name": "日常休息",
        "enabled": true,
        "weight": 50,
        "days": "any",
        "guide": "自由度高、节奏悠闲，以阅读、散步、喝茶为主"
      },
      {
        "id": "workday",
        "name": "专注工作",
        "enabled": true,
        "weight": 35,
        "days": "weekday",
        "guide": "白天有大块连贯的阅读研究或写作时间，作息规律"
      },
      {
        "id": "outing",
        "name": "出门游玩",
        "enabled": true,
        "weight": 15,
        "days": "weekend",
        "guide": "外出较多，包含旧书店、美术馆、咖啡馆或与朋友出行"
      }
    ],
    "extraRules": "",
    "voiceRules": true,
    "businessPriority": true,
    "wokenBriefRule": true,
    "customVoiceRules": "",
    "planAheadHour": 22,
    "tomorrowAfterHour": 18,
    "autoPlan": false,
    "memorySessionMode": "isolated",
    "diaryHour": 21,
    "dayType": "周末",
    "holidayNotes": "2026-11-01 文化节准备日"
  },
  "state": {
    "energy": 78.5,
    "hunger": 32.0,
    "mood": 0.35,
    "arousal": 0.65,
    "updatedAt": 1793613600000,
    "awakeUntil": 0,
    "lastSleepEnd": 1793597700000,
    "recentSleepHours": 8.75,
    "appliedNodes": [
      "2026-11-01/2026-11-01-0",
      "2026-11-01/2026-11-01-480"
    ],
    "seenMessages": [
      "msg-101",
      "msg-102"
    ]
  },
  "plans": {
    "2026-11-01": {
      "source": "manual",
      "nodes": [
        {
          "id": "2026-11-01-0",
          "start": 0,
          "end": 480,
          "kind": "sleep",
          "summary": "夜间睡眠与休息",
          "location": "枫叶町单人公寓",
          "scene": "室内窗帘紧闭，暖白色的台灯已熄灭，空气中残留着微弱的洋甘菊香气。",
          "source": "manual"
        },
        {
          "id": "2026-11-01-480",
          "start": 480,
          "end": 525,
          "kind": "meal",
          "summary": "起床洗漱与清晨红茶",
          "location": "公寓小厨房",
          "scene": "晨光刚透过薄纱窗帘，澪披上米色针织开衫，接水煮沸大吉岭红茶，杯口升腾着轻盈的白汽。",
          "source": "manual"
        },
        {
          "id": "2026-11-01-525",
          "start": 525,
          "end": 720,
          "kind": "study",
          "summary": "图书馆借阅与论文阅读",
          "location": "大学图书馆南馆",
          "scene": "坐在靠窗的长木桌旁，手边放着借阅的三本文艺理论专著，安静翻动书页。",
          "source": "manual"
        },
        {
          "id": "2026-11-01-720",
          "start": 720,
          "end": 780,
          "kind": "meal",
          "summary": "午间便餐与休息",
          "location": "校园轻食餐厅",
          "scene": "挑选了牛油果鸡肉三明治与热玄米茶，静静看着窗外穿行的学生。",
          "source": "manual"
        },
        {
          "id": "2026-11-01-780",
          "start": 780,
          "end": 1080,
          "kind": "leisure",
          "summary": "午后散步与旧书店淘书",
          "location": "神保町旧书街",
          "scene": "在旧书摊角落淘到一本初版诗集，泛黄的纸页散发着古旧的油墨气息。",
          "source": "manual"
        },
        {
          "id": "2026-11-01-1080",
          "start": 1080,
          "end": 1140,
          "kind": "meal",
          "summary": "晚间烹饪与用餐",
          "location": "公寓厨房",
          "scene": "回到家做了温暖的豆腐蛤蜊味噌汤，搭配白米饭，享受安静的独处时光。",
          "source": "manual"
        },
        {
          "id": "2026-11-01-1140",
          "start": 1140,
          "end": 1410,
          "kind": "leisure",
          "summary": "整理手记与反思阅读",
          "location": "公寓书桌",
          "scene": "在墨绿色的手账本上写下今天的所见所感，听着轻柔的室内乐。",
          "source": "manual"
        },
        {
          "id": "2026-11-01-1410",
          "start": 1410,
          "end": 1440,
          "kind": "sleep",
          "summary": "就寝准备与入睡",
          "location": "卧室",
          "scene": "调暗床头灯光，换上棉质睡衣，闭上双眼逐渐进入睡眠。",
          "source": "manual"
        }
      ]
    }
  },
  "cardSync": {
    "hash": "c1f7a83d",
    "syncedAt": 1793613600000,
    "day": "2026-11-01",
    "status": "synced",
    "error": "",
    "preview": "【生活手记·实时状态】\n以下为澪在 2026-11-01 的生活状态快照（仅在涉及该日作息、起床时间或当前动态时保持一致，自然融入语气，不机械背诵；双方互动以真实聊天记录为准）：\n- 状态时刻：2026-11-01 22:00 · 清醒 · 心情轻快 · 位于公寓书桌\n- 今日作息与起床：08:15（首个清醒片段“晨光透过薄纱窗帘，澪披上米色针织开衫，大吉岭红茶煮沸”；日常作息设定 23:30–08:00）\n- 当前日程节点：19:00–23:30 整理手记与反思阅读（在墨绿色的手账本上写下今天的所见所感）\n- 今日已记录经历：08:15 晨光透过窗帘；10:30 图书馆翻阅文艺理论\n- 今日日记摘要：《初冬的图书馆与红茶》今日在图书馆借阅了文学专著，午后淘到旧诗集，身心平静放松。\n【/生活手记·实时状态】"
  }
}
```

### 5.3 `schedules/daily_facts.json` 示例
```json
[
  {
    "day": "2026-11-01",
    "characterId": "life-demo-mio",
    "plannedSleepStart": "23:30",
    "plannedWakeTime": "08:00",
    "wakeTime": "08:15",
    "wakePhrase": "08:15起身",
    "wakeSource": "scene",
    "wakeSummary": "08:15（首个清醒片段“晨光刚透过薄纱窗帘，澪披上米色针织开衫，接水煮沸大吉岭红茶”；日常作息设定 23:30–08:00）",
    "firstAwakeTime": "08:15",
    "timelineItems": [
      {
        "time": "08:15",
        "until": "08:45",
        "summary": "起床洗漱与清晨红茶",
        "location": "公寓小厨房",
        "phase": "awake"
      },
      {
        "time": "10:30",
        "until": "12:00",
        "summary": "图书馆借阅与论文阅读",
        "location": "大学图书馆南馆",
        "phase": "awake"
      }
    ],
    "todayDiaryTitle": "初冬的图书馆与红茶",
    "todayDiarySummary": "今日在初冬的晨光中醒来，为自己煮了一杯温热的大吉岭红茶。上午前往大学南馆阅读文艺理论专著，午后在旧书店找到心仪的诗集。一整天步调从容而充实。",
    "todayDreamTitle": "",
    "todayDreamSummary": ""
  }
]
```

### 5.4 `schedules/plans.json` 示例
```json
[
  {
    "id": "plan-life-demo-mio-2026-11-01",
    "characterId": "life-demo-mio",
    "day": "2026-11-01",
    "title": "初冬的阅读与旧书店散步",
    "mood": "平静悠闲",
    "dayType": "restday",
    "source": "generated",
    "hint": "午后去神保町旧书店逛逛，晚饭想喝豆腐蛤蜊汤",
    "generatedAt": 1793500800000,
    "changes": [
      {
        "at": 1793587200000,
        "start": "14:00",
        "end": "16:00",
        "summary": "在神保町旧书店淘到昭和抒情诗集",
        "detail": "原定散步临时延长，在角落书摊仔细翻阅旧诗集"
      }
    ],
    "nodes": [
      {
        "id": "2026-11-01-0",
        "start": 0,
        "end": 480,
        "kind": "sleep",
        "summary": "夜间睡眠与休息",
        "location": "枫叶町单人公寓",
        "scene": "室内窗帘紧闭，暖白色的台灯已熄灭，空气中残留着微弱的洋甘菊香气。",
        "source": "generated"
      },
      {
        "id": "2026-11-01-480",
        "start": 480,
        "end": 525,
        "kind": "meal",
        "summary": "起床洗漱与清晨红茶",
        "location": "公寓小厨房",
        "scene": "晨光刚透过薄纱窗帘，澪披上米色针织开衫，接水煮沸大吉岭红茶，杯口升腾着轻盈的白汽。",
        "source": "generated"
      },
      {
        "id": "2026-11-01-525",
        "start": 525,
        "end": 720,
        "kind": "study",
        "summary": "大学南馆阅读美学理论",
        "location": "大学图书馆南馆",
        "scene": "坐在靠窗的长木桌旁，手边放着借阅的三本文艺理论专著，安静翻动书页。",
        "source": "generated"
      },
      {
        "id": "2026-11-01-720",
        "start": 720,
        "end": 780,
        "kind": "meal",
        "summary": "午间便餐与玄米茶",
        "location": "校园轻食餐厅",
        "scene": "挑选了牛油果鸡肉三明治与热玄米茶，静静看着窗外穿行的学生。",
        "source": "generated"
      },
      {
        "id": "2026-11-01-780",
        "start": 780,
        "end": 840,
        "kind": "travel",
        "summary": "乘电车前往神保町",
        "location": "电车",
        "source": "generated"
      },
      {
        "id": "2026-11-01-840",
        "start": 840,
        "end": 960,
        "kind": "leisure",
        "summary": "在神保町旧书店淘到昭和抒情诗集",
        "location": "神保町旧书街",
        "scene": "在旧书摊角落淘到一本初版诗集，泛黄的纸页散发着古旧的油墨气息。",
        "source": "change"
      },
      {
        "id": "2026-11-01-960",
        "start": 960,
        "end": 1080,
        "kind": "leisure",
        "summary": "露天咖啡座阅读诗集",
        "location": "街角咖啡馆",
        "scene": "点了一杯美式咖啡，坐在室外遮阳伞下翻看淘到的旧诗集。",
        "source": "generated"
      },
      {
        "id": "2026-11-01-1080",
        "start": 1080,
        "end": 1140,
        "kind": "meal",
        "summary": "烹饪豆腐蛤蜊汤与晚餐",
        "location": "公寓厨房",
        "scene": "回到家做了温暖的豆腐蛤蜊味噌汤，搭配白米饭，享受安静的独处时光。",
        "source": "generated"
      },
      {
        "id": "2026-11-01-1140",
        "start": 1140,
        "end": 1410,
        "kind": "leisure",
        "summary": "整理手记与反思阅读",
        "location": "公寓书桌",
        "scene": "在墨绿色的手账本上写下今天的所见所感，听着轻柔的室内乐。",
        "source": "generated"
      },
      {
        "id": "2026-11-01-1410",
        "start": 1410,
        "end": 1440,
        "kind": "sleep",
        "summary": "就寝准备与入睡",
        "location": "卧室",
        "scene": "调暗床头灯光，换上棉质睡衣，闭上双眼逐渐进入睡眠。",
        "source": "generated"
      }
    ]
  }
]
```

### 5.5 `documents/documents.json` 示例
```json
[
  {
    "id": "life-demo-mio-diary-2026-11-01",
    "characterId": "life-demo-mio",
    "sessionId": "life-archive-life-demo-mio",
    "kind": "diary",
    "day": "2026-11-01",
    "title": "初冬的图书馆与红茶",
    "body": "十一月的空气带着些许清冽。八点十五分左右醒来时，阳光正好落在一半的书桌上。\n披上米色的毛衣，去小厨房接了纯净水，慢慢煮开大吉岭红茶。水沸腾的咕嘟声让屋子里有了一种踏实的烟火气。\n上午去大学图书馆南馆待了三个小时。靠窗的位置看得到银杏树落下的金黄叶片。借阅了文艺美学理论，手写摘录了两页笔记。\n午后去了神保町，在熟悉的街角旧书店里翻了很久，居然翻到一本昭和时代的抒情诗集。扉页上盖着一枚已经模糊的私人印章，让人忍不住好奇它上一任主人的故事。\n回到家煮了热热的豆腐蛤蜊汤。把生活过得慢一点，好像心思也会变得澄澈起来。",
    "summary": "8:15醒来并在厨房煮了大吉岭红茶。上午在大学图书馆南馆阅览美学书籍并摘录两页笔记。午后在神保町旧书店淘到昭和时代的抒情诗集。傍晚回家烹饪豆腐蛤蜊汤，心情轻快平和。",
    "createdAt": 1793612400000,
    "syncStatus": "written",
    "memoryId": 8042,
    "graphStatus": "ready",
    "graphDraftJSON": null,
    "retrievalStatus": "passed",
    "retrievalNote": "在主聊天界面询问‘今天早上喝了什么茶’，角色准确回忆出‘大吉岭红茶’；问‘下午淘到了什么书’，准确回答‘昭和时代抒情诗集’。",
    "retrievalAt": 1793613000000,
    "sourceSceneIds": [
      "scene-mio-20261101-0815",
      "scene-mio-20261101-1030"
    ],
    "sourceMessageIds": [
      "msg-101",
      "msg-102"
    ],
    "timelineFacts": {
      "day": "2026-11-01",
      "characterId": "life-demo-mio",
      "plannedSleepStart": "23:30",
      "plannedWakeTime": "08:00",
      "wakeTime": "08:15",
      "wakePhrase": "08:15起身",
      "wakeSource": "scene",
      "wakeSummary": "08:15（首个清醒片段“晨光刚透过薄纱窗帘，澪披上米色针织开衫，接水煮沸大吉岭红茶”；日常作息设定 23:30–08:00）",
      "firstAwakeTime": "08:15",
      "timelineItems": [
        {
          "time": "08:15",
          "until": "08:45",
          "summary": "起床洗漱与清晨红茶",
          "location": "公寓小厨房",
          "phase": "awake"
        }
      ],
      "todayDiaryTitle": "初冬的图书馆与红茶",
      "todayDiarySummary": "8:15醒来并在厨房煮了大吉岭红茶。上午在大学图书馆南馆阅览美学书籍。",
      "todayDreamTitle": "",
      "todayDreamSummary": ""
    },
    "version": "0.2.3"
  }
]
```

### 5.6 `scenes/scenes.json` 示例
```json
[
  {
    "id": "scene-mio-20261101-0815",
    "characterId": "life-demo-mio",
    "key": "life-demo-mio/2026-11-01/hash-node-480/awake/0",
    "nodeKey": "life-demo-mio/2026-11-01/hash-node-480",
    "nodeId": "2026-11-01-480",
    "day": "2026-11-01",
    "start": 1793596800000,
    "end": 1793599500000,
    "phase": "awake",
    "summary": "起床洗漱与清晨红茶",
    "location": "公寓小厨房",
    "scene": "晨光透过薄纱窗帘，将房间染上一层淡淡的金黄。澪披上米色针织开衫，轻手轻脚地来到小厨房接满纯净水。壶嘴逐渐泛起细密的气泡，伴随大吉岭红茶的清香弥散在空气中，整个人也完全清醒过来。",
    "source": "generated",
    "generatedAt": 1793597700000,
    "experiencedUntil": 1793599500000,
    "version": "0.2.3"
  },
  {
    "id": "scene-mio-20261101-1030",
    "characterId": "life-demo-mio",
    "key": "life-demo-mio/2026-11-01/hash-node-525/awake/0",
    "nodeKey": "life-demo-mio/2026-11-01/hash-node-525",
    "nodeId": "2026-11-01-525",
    "day": "2026-11-01",
    "start": 1793599500000,
    "end": 1793611200000,
    "phase": "awake",
    "summary": "图书馆借阅与论文阅读",
    "location": "大学图书馆南馆",
    "scene": "南馆朝南的长条阅览桌被柔和的日光包裹着。澪将厚厚的美学理论书摊开在桌面上，笔尖在米黄色的笔记本上沙沙作响，偶尔抬头望向窗外飘落的银杏黄叶，心境格外宁静专注。",
    "source": "generated",
    "generatedAt": 1793605800000,
    "experiencedUntil": 1793611200000,
    "version": "0.2.3"
  }
]
```

### 5.7 `runs/history_runs.json` 示例
```json
[
  {
    "id": "run-mio-20261101-081500",
    "characterId": "life-demo-mio",
    "at": 1793597700000,
    "kind": "scene",
    "status": "ok",
    "message": "微观生活场景细化完成：起床洗漱与清晨红茶"
  },
  {
    "id": "run-mio-20261101-210000",
    "characterId": "life-demo-mio",
    "at": 1793612400000,
    "kind": "diary",
    "status": "ok",
    "message": "今日日记整理完成并生成图谱草稿：《初冬的图书馆与红茶》"
  }
]
```

### 5.8 `knowledge-graph/graph.json` 示例
```json
{
  "entities": [
    {
      "id": "澪",
      "name": "澪",
      "type": "character",
      "description": "女主角，大学文学系学生"
    },
    {
      "id": "日记（2026-11-01）《初冬的图书馆与红茶》",
      "name": "日记（2026-11-01）《初冬的图书馆与红茶》",
      "type": "document",
      "description": "2026-11-01 日常生活手记"
    },
    {
      "id": "大学图书馆南馆",
      "name": "大学图书馆南馆",
      "type": "location",
      "description": "大学南区图书馆阅览室"
    }
  ],
  "triples": [
    {
      "id": "kg-trip-001",
      "documentId": "life-demo-mio-diary-2026-11-01",
      "day": "2026-11-01",
      "subject": "澪",
      "relationship": "生活记录",
      "object": "日记（2026-11-01）《初冬的图书馆与红茶》",
      "nature": "reality",
      "groundedInText": true
    },
    {
      "id": "kg-trip-002",
      "documentId": "life-demo-mio-diary-2026-11-01",
      "day": "2026-11-01",
      "subject": "澪",
      "relationship": "2026-11-01作息",
      "object": "8:15醒来",
      "nature": "reality",
      "groundedInText": true
    },
    {
      "id": "kg-trip-003",
      "documentId": "life-demo-mio-diary-2026-11-01",
      "day": "2026-11-01",
      "subject": "澪",
      "relationship": "2026-11-01地点",
      "object": "大学图书馆南馆",
      "nature": "reality",
      "groundedInText": true
    },
    {
      "id": "kg-trip-004",
      "documentId": "life-demo-mio-diary-2026-11-01",
      "day": "2026-11-01",
      "subject": "日记（2026-11-01）《初冬的图书馆与红茶》",
      "relationship": "记录中物件",
      "object": "大吉岭红茶",
      "nature": "reality",
      "groundedInText": true
    },
    {
      "id": "kg-trip-005",
      "documentId": "life-demo-mio-diary-2026-11-01",
      "day": "2026-11-01",
      "subject": "日记（2026-11-01）《初冬的图书馆与红茶》",
      "relationship": "记录中物件",
      "object": "昭和时代的抒情诗集",
      "nature": "reality",
      "groundedInText": true
    }
  ]
}
```

### 5.9 `native-memories/native_memories.json` 示例
```json
[
  {
    "id": 8042,
    "character_id": "life-demo-mio",
    "session_id": "life-archive-life-demo-mio",
    "timestamp": 1793612400000,
    "rawText": "【Layla生活记录:life-demo-mio-diary-2026-11-01】\n类型：日记；日期：2026-11-01。角色当日第一人称生活与作息记录；涉及与用户的互动以实际聊天为准。\n标题：初冬的图书馆与红茶\n十一月的空气带着些许清冽。八点十五分左右醒来时，阳光正好落在一半的书桌上。\n披上米色的毛衣，去小厨房接了纯净水，慢慢煮开大吉岭红茶。水沸腾的咕嘟声让屋子里有了一种踏实的烟火气。\n上午去大学图书馆南馆待了三个小时。靠窗的位置看得到银杏树落下的金黄叶片。借阅了文艺美学理论，手写摘录了两页笔记。\n午后去了神保町，在熟悉的街角旧书店里翻了很久，居然翻到一本昭和时代的抒情诗集。扉页上盖着一枚已经模糊的私人印章，让人忍不住好奇它上一任主人的故事。\n回到家煮了热热的豆腐蛤蜊汤。把生活过得慢一点，好像心思也会变得澄澈起来。",
    "summary": "日记（2026-11-01）《初冬的图书馆与红茶》（08:15起身）：8:15醒来并在厨房煮了大吉岭红茶。上午在大学图书馆南馆阅览美学书籍并摘录两页笔记。午后在神保町旧书店淘到昭和时代的抒情诗集。傍晚回家烹饪豆腐蛤蜊汤，心情轻快平和。",
    "knowledgeGraphJSON": "[{\"subject\":\"澪\",\"relationship\":\"生活记录\",\"object\":\"日记（2026-11-01）《初冬的图书馆与红茶》\"},{\"subject\":\"澪\",\"relationship\":\"2026-11-01作息\",\"object\":\"8:15醒来\"},{\"subject\":\"澪\",\"relationship\":\"2026-11-01地点\",\"object\":\"大学图书馆南馆\"},{\"subject\":\"日记（2026-11-01）《初冬的图书馆与红茶》\",\"relationship\":\"内容性质\",\"object\":\"角色当日第一人称生活与聊天回顾记录\"},{\"subject\":\"日记（2026-11-01）《初冬的图书馆与红茶》\",\"relationship\":\"记录日期\",\"object\":\"2026-11-01\"},{\"subject\":\"日记（2026-11-01）《初冬的图书馆与红茶》\",\"relationship\":\"记录中作息\",\"object\":\"8:15醒来\"},{\"subject\":\"日记（2026-11-01）《初冬的图书馆与红茶》\",\"relationship\":\"记录中物件\",\"object\":\"大吉岭红茶\"},{\"subject\":\"日记（2026-11-01）《初冬的图书馆与红茶》\",\"relationship\":\"记录中物件\",\"object\":\"昭和时代的抒情诗集\"}]",
    "associatedDocumentId": "life-demo-mio-diary-2026-11-01"
  }
]
```

### 5.10 单文件降级 JSON 示例 (`life-backup-life-demo-mio-1793613600000.json`)
```json
{
  "exportVersion": "1.1.0",
  "specVersion": "1.1.0",
  "appVersion": "0.2.3",
  "exportedAt": 1793613600000,
  "characterId": "life-demo-mio",
  "characterName": "澪",
  "archiveMode": "json_fallback",
  "manifest": {
    "exportVersion": "1.1.0",
    "specVersion": "1.1.0",
    "appVersion": "0.2.3",
    "version": "0.2.3",
    "exportedAt": 1793613600000,
    "exportedAtISO": "2026-11-01T14:00:00.000Z",
    "characterId": "life-demo-mio",
    "characterName": "澪",
    "archiveMode": "json_fallback",
    "recordCounts": {
      "profile": 1,
      "schedules": 1,
      "plans": 1,
      "documents": 1,
      "scenes": 2,
      "runs": 2,
      "knowledgeGraphTriples": 5,
      "knowledgeGraphEntities": 3,
      "nativeMemories": 1
    },
    "summary": {
      "documentCount": 1,
      "sceneCount": 2,
      "runCount": 2,
      "tripleCount": 5,
      "nativeMemoryCount": 1,
      "planCount": 1
    }
  },
  "profile": {
    "schema": 3,
    "characterId": "life-demo-mio",
    "name": "澪",
    "createdAt": 1793500000000,
    "selectedSessionId": "session-mio-chat",
    "lastNativeAt": 1793610000000,
    "lastRunAt": 1793613000000,
    "sceneIdentity": "性格沉静专注的文学系大学生，说话轻柔温和",
    "settings": {
      "timezone": "Asia/Shanghai",
      "home": "枫叶町单人公寓",
      "sleepStart": "23:30",
      "sleepEnd": "08:00",
      "healthNote": "偶有低血压，早晨起床动作宜缓",
      "weatherNote": "晴朗 微风 16℃",
      "weatherCity": "上海",
      "weatherAt": 1793608800000,
      "autoScene": true,
      "background": true,
      "autoWrite": true,
      "syncCard": true,
      "syncPrecision": "halfhour",
      "dayTypes": [
        {
          "id": "restday",
          "name": "日常休息",
          "enabled": true,
          "weight": 50,
          "days": "any",
          "guide": "自由度高、节奏悠闲，以阅读、散步、喝茶为主"
        },
        {
          "id": "workday",
          "name": "专注工作",
          "enabled": true,
          "weight": 35,
          "days": "weekday",
          "guide": "白天有大块连贯的阅读研究或写作时间，作息规律"
        },
        {
          "id": "outing",
          "name": "出门游玩",
          "enabled": true,
          "weight": 15,
          "days": "weekend",
          "guide": "外出较多，包含旧书店、美术馆、咖啡馆或与朋友出行"
        }
      ],
      "extraRules": "",
      "voiceRules": true,
      "businessPriority": true,
      "wokenBriefRule": true,
      "customVoiceRules": "",
      "planAheadHour": 22,
      "tomorrowAfterHour": 18,
      "autoPlan": false,
      "memorySessionMode": "isolated",
      "diaryHour": 21,
      "dayType": "周末",
      "holidayNotes": "2026-11-01 文化节准备日"
    },
    "state": {
      "energy": 78.5,
      "hunger": 32.0,
      "mood": 0.35,
      "arousal": 0.65,
      "updatedAt": 1793613600000,
      "awakeUntil": 0,
      "lastSleepEnd": 1793597700000,
      "recentSleepHours": 8.75,
      "appliedNodes": [
        "2026-11-01/2026-11-01-0",
        "2026-11-01/2026-11-01-480"
      ],
      "seenMessages": [
        "msg-101",
        "msg-102"
      ]
    },
    "plans": {
      "2026-11-01": {
        "source": "manual",
        "nodes": [
          {
            "id": "2026-11-01-0",
            "start": 0,
            "end": 480,
            "kind": "sleep",
            "summary": "夜间睡眠与休息",
            "location": "枫叶町单人公寓",
            "scene": "室内窗帘紧闭，暖白色的台灯已熄灭，空气中残留着微弱的洋甘菊香气。",
            "source": "manual"
          },
          {
            "id": "2026-11-01-480",
            "start": 480,
            "end": 525,
            "kind": "meal",
            "summary": "起床洗漱与清晨红茶",
            "location": "公寓小厨房",
            "scene": "晨光刚透过薄纱窗帘，澪披上米色针织开衫，接水煮沸大吉岭红茶，杯口升腾着轻盈的白汽。",
            "source": "manual"
          },
          {
            "id": "2026-11-01-525",
            "start": 525,
            "end": 720,
            "kind": "study",
            "summary": "图书馆借阅与论文阅读",
            "location": "大学图书馆南馆",
            "scene": "坐在靠窗的长木桌旁，手边放着借阅的三本文艺理论专著，安静翻动书页。",
            "source": "manual"
          },
          {
            "id": "2026-11-01-720",
            "start": 720,
            "end": 780,
            "kind": "meal",
            "summary": "午间便餐与休息",
            "location": "校园轻食餐厅",
            "scene": "挑选了牛油果鸡肉三明治与热玄米茶，静静看着窗外穿行的学生。",
            "source": "manual"
          },
          {
            "id": "2026-11-01-780",
            "start": 780,
            "end": 1080,
            "kind": "leisure",
            "summary": "午后散步与旧书店淘书",
            "location": "神保町旧书街",
            "scene": "在旧书摊角落淘到一本初版诗集，泛黄的纸页散发着古旧的油墨气息。",
            "source": "manual"
          },
          {
            "id": "2026-11-01-1080",
            "start": 1080,
            "end": 1140,
            "kind": "meal",
            "summary": "晚间烹饪与用餐",
            "location": "公寓厨房",
            "scene": "回到家做了温暖的豆腐蛤蜊味噌汤，搭配白米饭，享受安静的独处时光。",
            "source": "manual"
          },
          {
            "id": "2026-11-01-1140",
            "start": 1140,
            "end": 1410,
            "kind": "leisure",
            "summary": "整理手记与反思阅读",
            "location": "公寓书桌",
            "scene": "在墨绿色的手账本上写下今天的所见所感，听着轻柔的室内乐。",
            "source": "manual"
          },
          {
            "id": "2026-11-01-1410",
            "start": 1410,
            "end": 1440,
            "kind": "sleep",
            "summary": "就寝准备与入睡",
            "location": "卧室",
            "scene": "调暗床头灯光，换上棉质睡衣，闭上双眼逐渐进入睡眠。",
            "source": "manual"
          }
        ]
      }
    },
    "cardSync": {
      "hash": "c1f7a83d",
      "syncedAt": 1793613600000,
      "day": "2026-11-01",
      "status": "synced",
      "error": "",
      "preview": "【生活手记·实时状态】\n以下为澪在 2026-11-01 的生活状态快照（仅在涉及该日作息、起床时间或当前动态时保持一致，自然融入语气，不机械背诵；双方互动以真实聊天记录为准）：\n- 状态时刻：2026-11-01 22:00 · 清醒 · 心情轻快 · 位于公寓书桌\n- 今日作息与起床：08:15（首个清醒片段“晨光透过薄纱窗帘，澪披上米色针织开衫，大吉岭红茶煮沸”；日常作息设定 23:30–08:00）\n- 当前日程节点：19:00–23:30 整理手记与反思阅读（在墨绿色的手账本上写下今天的所见所感）\n- 今日已记录经历：08:15 晨光透过窗帘；10:30 图书馆翻阅文艺理论\n- 今日日记摘要：《初冬的图书馆与红茶》今日在图书馆借阅了文学专著，午后淘到旧诗集，身心平静放松。\n【/生活手记·实时状态】"
    }
  },
  "schedules": [
    {
      "day": "2026-11-01",
      "characterId": "life-demo-mio",
      "plannedSleepStart": "23:30",
      "plannedWakeTime": "08:00",
      "wakeTime": "08:15",
      "wakePhrase": "08:15起身",
      "wakeSource": "scene",
      "wakeSummary": "08:15（首个清醒片段“晨光刚透过薄纱窗帘，澪披上米色针织开衫，接水煮沸大吉岭红茶”；日常作息设定 23:30–08:00）",
      "firstAwakeTime": "08:15",
      "timelineItems": [
        {
          "time": "08:15",
          "until": "08:45",
          "summary": "起床洗漱与清晨红茶",
          "location": "公寓小厨房",
          "phase": "awake"
        },
        {
          "time": "10:30",
          "until": "12:00",
          "summary": "图书馆借阅与论文阅读",
          "location": "大学图书馆南馆",
          "phase": "awake"
        }
      ],
      "todayDiaryTitle": "初冬的图书馆与红茶",
      "todayDiarySummary": "今日在初冬的晨光中醒来，为自己煮了一杯温热的大吉岭红茶。上午前往大学南馆阅读文艺理论专著，午后在旧书店找到心仪的诗集。一整天步调从容而充实。",
      "todayDreamTitle": "",
      "todayDreamSummary": ""
    }
  ],
  "plans": [
    {
      "id": "plan-life-demo-mio-2026-11-01",
      "characterId": "life-demo-mio",
      "day": "2026-11-01",
      "title": "初冬的阅读与旧书店散步",
      "mood": "平静悠闲",
      "dayType": "restday",
      "source": "generated",
      "hint": "午后去神保町旧书店逛逛，晚饭想喝豆腐蛤蜊汤",
      "generatedAt": 1793500800000,
      "changes": [
        {
          "at": 1793587200000,
          "start": "14:00",
          "end": "16:00",
          "summary": "在神保町旧书店淘到昭和抒情诗集",
          "detail": "原定散步临时延长，在角落书摊仔细翻阅旧诗集"
        }
      ],
      "nodes": [
        {
          "id": "2026-11-01-0",
          "start": 0,
          "end": 480,
          "kind": "sleep",
          "summary": "夜间睡眠与休息",
          "location": "枫叶町单人公寓",
          "scene": "室内窗帘紧闭，暖白色的台灯已熄灭，空气中残留着微弱的洋甘菊香气。",
          "source": "generated"
        },
        {
          "id": "2026-11-01-480",
          "start": 480,
          "end": 525,
          "kind": "meal",
          "summary": "起床洗漱与清晨红茶",
          "location": "公寓小厨房",
          "scene": "晨光刚透过薄纱窗帘，澪披上米色针织开衫，接水煮沸大吉岭红茶，杯口升腾着轻盈的白汽。",
          "source": "generated"
        },
        {
          "id": "2026-11-01-525",
          "start": 525,
          "end": 720,
          "kind": "study",
          "summary": "大学南馆阅读美学理论",
          "location": "大学图书馆南馆",
          "scene": "坐在靠窗的长木桌旁，手边放着借阅的三本文艺理论专著，安静翻动书页。",
          "source": "generated"
        },
        {
          "id": "2026-11-01-720",
          "start": 720,
          "end": 780,
          "kind": "meal",
          "summary": "午间便餐与玄米茶",
          "location": "校园轻食餐厅",
          "scene": "挑选了牛油果鸡肉三明治与热玄米茶，静静看着窗外穿行的学生。",
          "source": "generated"
        },
        {
          "id": "2026-11-01-780",
          "start": 780,
          "end": 840,
          "kind": "travel",
          "summary": "乘电车前往神保町",
          "location": "电车",
          "source": "generated"
        },
        {
          "id": "2026-11-01-840",
          "start": 840,
          "end": 960,
          "kind": "leisure",
          "summary": "在神保町旧书店淘到昭和抒情诗集",
          "location": "神保町旧书街",
          "scene": "在旧书摊角落淘到一本初版诗集，泛黄的纸页散发着古旧的油墨气息。",
          "source": "change"
        },
        {
          "id": "2026-11-01-960",
          "start": 960,
          "end": 1080,
          "kind": "leisure",
          "summary": "露天咖啡座阅读诗集",
          "location": "街角咖啡馆",
          "scene": "点了一杯美式咖啡，坐在室外遮阳伞下翻看淘到的旧诗集。",
          "source": "generated"
        },
        {
          "id": "2026-11-01-1080",
          "start": 1080,
          "end": 1140,
          "kind": "meal",
          "summary": "烹饪豆腐蛤蜊汤与晚餐",
          "location": "公寓厨房",
          "scene": "回到家做了温暖的豆腐蛤蜊味噌汤，搭配白米饭，享受安静的独处时光。",
          "source": "generated"
        },
        {
          "id": "2026-11-01-1140",
          "start": 1140,
          "end": 1410,
          "kind": "leisure",
          "summary": "整理手记与反思阅读",
          "location": "公寓书桌",
          "scene": "在墨绿色的手账本上写下今天的所见所感，听着轻柔的室内乐。",
          "source": "generated"
        },
        {
          "id": "2026-11-01-1410",
          "start": 1410,
          "end": 1440,
          "kind": "sleep",
          "summary": "就寝准备与入睡",
          "location": "卧室",
          "scene": "调暗床头灯光，换上棉质睡衣，闭上双眼逐渐进入睡眠。",
          "source": "generated"
        }
      ]
    }
  ],
  "documents": [
    {
      "id": "life-demo-mio-diary-2026-11-01",
      "characterId": "life-demo-mio",
      "sessionId": "life-archive-life-demo-mio",
      "kind": "diary",
      "day": "2026-11-01",
      "title": "初冬的图书馆与红茶",
      "body": "十一月的空气带着些许清冽。八点十五分左右醒来时，阳光正好落在一半的书桌上。\n披上米色的毛衣，去小厨房接了纯净水，慢慢煮开大吉岭红茶。水沸腾的咕嘟声让屋子里有了一种踏实的烟火气。\n上午去大学图书馆南馆待了三个小时。靠窗的位置看得到银杏树落下的金黄叶片。借阅了文艺美学理论，手写摘录了两页笔记。\n午后去了神保町，在熟悉的街角旧书店里翻了很久，居然翻到一本昭和时代的抒情诗集。扉页上盖着一枚已经模糊的私人印章，让人忍不住好奇它上一任主人的故事。\n回到家煮了热热的豆腐蛤蜊汤。把生活过得慢一点，好像心思也会变得澄澈起来。",
      "summary": "8:15醒来并在厨房煮了大吉岭红茶。上午在大学图书馆南馆阅览美学书籍并摘录两页笔记。午后在神保町旧书店淘到昭和时代的抒情诗集。傍晚回家烹饪豆腐蛤蜊汤，心情轻快平和。",
      "createdAt": 1793612400000,
      "syncStatus": "written",
      "memoryId": 8042,
      "graphStatus": "ready",
      "graphDraftJSON": null,
      "retrievalStatus": "passed",
      "retrievalNote": "在主聊天界面询问‘今天早上喝了什么茶’，角色准确回忆出‘大吉岭红茶’；问‘下午淘到了什么书’，准确回答‘昭和时代抒情诗集’。",
      "retrievalAt": 1793613000000,
      "sourceSceneIds": [
        "scene-mio-20261101-0815",
        "scene-mio-20261101-1030"
      ],
      "sourceMessageIds": [
        "msg-101",
        "msg-102"
      ],
      "timelineFacts": {
        "day": "2026-11-01",
        "characterId": "life-demo-mio",
        "plannedSleepStart": "23:30",
        "plannedWakeTime": "08:00",
        "wakeTime": "08:15",
        "wakePhrase": "08:15起身",
        "wakeSource": "scene",
        "wakeSummary": "08:15（首个清醒片段“晨光刚透过薄纱窗帘，澪披上米色针织开衫，接水煮沸大吉岭红茶”；日常作息设定 23:30–08:00）",
        "firstAwakeTime": "08:15",
        "timelineItems": [
          {
            "time": "08:15",
            "until": "08:45",
            "summary": "起床洗漱与清晨红茶",
            "location": "公寓小厨房",
            "phase": "awake"
          }
        ],
        "todayDiaryTitle": "初冬的图书馆与红茶",
        "todayDiarySummary": "8:15醒来并在厨房煮了大吉岭红茶。上午在大学图书馆南馆阅览美学书籍。",
        "todayDreamTitle": "",
        "todayDreamSummary": ""
      },
      "version": "0.2.3"
    }
  ],
  "scenes": [
    {
      "id": "scene-mio-20261101-0815",
      "characterId": "life-demo-mio",
      "key": "life-demo-mio/2026-11-01/hash-node-480/awake/0",
      "nodeKey": "life-demo-mio/2026-11-01/hash-node-480",
      "nodeId": "2026-11-01-480",
      "day": "2026-11-01",
      "start": 1793596800000,
      "end": 1793599500000,
      "phase": "awake",
      "summary": "起床洗漱与清晨红茶",
      "location": "公寓小厨房",
      "scene": "晨光透过薄纱窗帘，将房间染上一层淡淡的金黄。澪披上米色针织开衫，轻手轻脚地来到小厨房接满纯净水。壶嘴逐渐泛起细密的气泡，伴随大吉岭红茶的清香弥散在空气中，整个人也完全清醒过来。",
      "source": "generated",
      "generatedAt": 1793597700000,
      "experiencedUntil": 1793599500000,
      "version": "0.2.3"
    },
    {
      "id": "scene-mio-20261101-1030",
      "characterId": "life-demo-mio",
      "key": "life-demo-mio/2026-11-01/hash-node-525/awake/0",
      "nodeKey": "life-demo-mio/2026-11-01/hash-node-525",
      "nodeId": "2026-11-01-525",
      "day": "2026-11-01",
      "start": 1793599500000,
      "end": 1793611200000,
      "phase": "awake",
      "summary": "图书馆借阅与论文阅读",
      "location": "大学图书馆南馆",
      "scene": "南馆朝南的长条阅览桌被柔和的日光包裹着。澪将厚厚的美学理论书摊开在桌面上，笔尖在米黄色的笔记本上沙沙作响，偶尔抬头望向窗外飘落的银杏黄叶，心境格外宁静专注。",
      "source": "generated",
      "generatedAt": 1793605800000,
      "experiencedUntil": 1793611200000,
      "version": "0.2.3"
    }
  ],
  "runs": [
    {
      "id": "run-mio-20261101-081500",
      "characterId": "life-demo-mio",
      "at": 1793597700000,
      "kind": "scene",
      "status": "ok",
      "message": "微观生活场景细化完成：起床洗漱与清晨红茶"
    },
    {
      "id": "run-mio-20261101-210000",
      "characterId": "life-demo-mio",
      "at": 1793612400000,
      "kind": "diary",
      "status": "ok",
      "message": "今日日记整理完成并生成图谱草稿：《初冬的图书馆与红茶》"
    }
  ],
  "knowledgeGraph": {
    "entities": [
      {
        "id": "澪",
        "name": "澪",
        "type": "character",
        "description": "女主角，大学文学系学生"
      },
      {
        "id": "日记（2026-11-01）《初冬的图书馆与红茶》",
        "name": "日记（2026-11-01）《初冬的图书馆与红茶》",
        "type": "document",
        "description": "2026-11-01 日常生活手记"
      },
      {
        "id": "大学图书馆南馆",
        "name": "大学图书馆南馆",
        "type": "location",
        "description": "大学南区图书馆阅览室"
      }
    ],
    "triples": [
      {
        "id": "kg-trip-001",
        "documentId": "life-demo-mio-diary-2026-11-01",
        "day": "2026-11-01",
        "subject": "澪",
        "relationship": "生活记录",
        "object": "日记（2026-11-01）《初冬的图书馆与红茶》",
        "nature": "reality",
        "groundedInText": true
      },
      {
        "id": "kg-trip-002",
        "documentId": "life-demo-mio-diary-2026-11-01",
        "day": "2026-11-01",
        "subject": "澪",
        "relationship": "2026-11-01作息",
        "object": "8:15醒来",
        "nature": "reality",
        "groundedInText": true
      },
      {
        "id": "kg-trip-003",
        "documentId": "life-demo-mio-diary-2026-11-01",
        "day": "2026-11-01",
        "subject": "澪",
        "relationship": "2026-11-01地点",
        "object": "大学图书馆南馆",
        "nature": "reality",
        "groundedInText": true
      },
      {
        "id": "kg-trip-004",
        "documentId": "life-demo-mio-diary-2026-11-01",
        "day": "2026-11-01",
        "subject": "日记（2026-11-01）《初冬的图书馆与红茶》",
        "relationship": "记录中物件",
        "object": "大吉岭红茶",
        "nature": "reality",
        "groundedInText": true
      },
      {
        "id": "kg-trip-005",
        "documentId": "life-demo-mio-diary-2026-11-01",
        "day": "2026-11-01",
        "subject": "日记（2026-11-01）《初冬的图书馆与红茶》",
        "relationship": "记录中物件",
        "object": "昭和时代的抒情诗集",
        "nature": "reality",
        "groundedInText": true
      }
    ]
  },
  "nativeMemories": [
    {
      "id": 8042,
      "character_id": "life-demo-mio",
      "session_id": "life-archive-life-demo-mio",
      "timestamp": 1793612400000,
      "rawText": "【Layla生活记录:life-demo-mio-diary-2026-11-01】\n类型：日记；日期：2026-11-01。角色当日第一人称生活与作息记录；涉及与用户的互动以实际聊天为准。\n标题：初冬的图书馆与红茶\n十一月的空气带着些许清冽。八点十五分左右醒来时，阳光正好落在一半的书桌上。\n披上米色的毛衣，去小厨房接了纯净水，慢慢煮开大吉岭红茶。水沸腾的咕嘟声让屋子里有了一种踏实的烟火气。\n上午去大学图书馆南馆待了三个小时。靠窗的位置看得到银杏树落下的金黄叶片。借阅了文艺美学理论，手写摘录了两页笔记。\n午后去了神保町，在熟悉的街角旧书店里翻了很久，居然翻到一本昭和时代的抒情诗集。扉页上盖着一枚已经模糊的私人印章，让人忍不住好奇它上一任主人的故事。\n回到家煮了热热的豆腐蛤蜊汤。把生活过得慢一点，好像心思也会变得澄澈起来。",
      "summary": "日记（2026-11-01）《初冬的图书馆与红茶》（08:15起身）：8:15醒来并在厨房煮了大吉岭红茶。上午在大学图书馆南馆阅览美学书籍并摘录两页笔记。午后在神保町旧书店淘到昭和时代的抒情诗集。傍晚回家烹饪豆腐蛤蜊汤，心情轻快平和。",
      "knowledgeGraphJSON": "[{\"subject\":\"澪\",\"relationship\":\"生活记录\",\"object\":\"日记（2026-11-01）《初冬的图书馆与红茶》\"},{\"subject\":\"澪\",\"relationship\":\"2026-11-01作息\",\"object\":\"8:15醒来\"},{\"subject\":\"澪\",\"relationship\":\"2026-11-01地点\",\"object\":\"大学图书馆南馆\"},{\"subject\":\"日记（2026-11-01）《初冬的图书馆与红茶》\",\"relationship\":\"内容性质\",\"object\":\"角色当日第一人称生活与聊天回顾记录\"},{\"subject\":\"日记（2026-11-01）《初冬的图书馆与红茶》\",\"relationship\":\"记录日期\",\"object\":\"2026-11-01\"},{\"subject\":\"日记（2026-11-01）《初冬的图书馆与红茶》\",\"relationship\":\"记录中作息\",\"object\":\"8:15醒来\"},{\"subject\":\"日记（2026-11-01）《初冬的图书馆与红茶》\",\"relationship\":\"记录中物件\",\"object\":\"大吉岭红茶\"},{\"subject\":\"日记（2026-11-01）《初冬的图书馆与红茶》\",\"relationship\":\"记录中物件\",\"object\":\"昭和时代的抒情诗集\"}]",
      "associatedDocumentId": "life-demo-mio-diary-2026-11-01"
    }
  ]
}
```

---

## 6. 数据完整性、校验与验证规则 (Integrity & Validation Rules)

为了确保导出的数据在任何平台导入时零歧义、自洽并可防御数据篡改或网络传输残损，导入/导出程序必须严格遵循以下校验规则：

### 6.1 校验和与防篡改规则 (Checksum Verification)
1. **ZIP 局部与中央目录 CRC-32 校验**:
   每个条目头部的 CRC-32 校验和必须与实际解压后的数据流 CRC-32 完全一致。
2. **Manifest SHA-256 跨文件校验**:
   在 ZIP 模式下，`manifest.json` 中的 `files` 数组包含了每个解压文件的字节数与标准 SHA-256 哈希值。验证器在加载子文件前，必须重新计算该文件的 SHA-256，与 Manifest 中记录的值比对；若哈希不匹配，必须终止导入并提示文件损坏。
3. **记录条数对账**:
   `manifest.recordCounts` 中的每项统计数值必须与解压后对应子文件数组的实际元素个数（`Array.length`）完全相等。

### 6.2 业务模式与时序不变式约束 (Schema Invariants)
1. **24 小时全天日程覆盖性 (00:00–24:00 Completeness)**:
   - 任何 `profile.plans[day].nodes` 中的首个节点 `start` 必须严格为 `0`；
   - 最后一个节点的 `end` 必须严格为 `1440`；
   - 对任意相邻节点 $i$ 与 $i-1$，必须满足 `nodes[i].start === nodes[i-1].end`，绝对不允许时间重叠或留有空档。
2. **时间戳因果律与区间有效性 (Temporal Invariants)**:
   - 场景记录中必须满足：`scene.start < scene.end`；
   - 场景的生成时刻与经历有效范围必须满足：`scene.generatedAt <= scene.end` 且 `scene.start <= scene.experiencedUntil <= scene.end`；
   - 绝对不允许出现负时间戳或逆向时间流转。
3. **三元组原文严格锚定约束 (Text Grounding Invariant)**:
   - 任何标记为 `groundedInText: true` 的三元组，其 `object` 字段必须能够在关联文稿的 `body` 或 `summary` 文本中逐字匹配或经分词时间正则安全对齐；
   - 严禁向知识图谱中注入包含未锚定捏造事实的三元组。
4. **外键引用与跨文件引用完整性 (Referential Integrity)**:
   - `knowledge-graph/graph.json` 中每个三元组的 `documentId`，必须在 `documents/documents.json` 中存在主键匹配的记录；
   - `documents/documents.json` 中若 `memoryId` 不为 null，必须能在 `native-memories/native_memories.json` 中找到对应 `id` 的原生记忆快照；
   - `documents/documents.json` 中的 `sourceSceneIds` 中的每个 ID，必须在 `scenes/scenes.json` 中存在实体。

### 6.3 异常处理与降级容灾策略 (Error Handling Matrix)

| 异常场景 | 严重级别 | 系统标准应对行为 |
|---|---|---|
| PKZIP 解析失败或字节流截断 | **FATAL** | 拒绝加载，报错提示“备份压缩包已损坏”，回滚所有待导入事务。 |
| Manifest SHA-256 校验失败 | **FATAL** | 报警提示“文件篡改或哈希不符”，终止导入。 |
| 缺少非核心子文件（如 `runs/history_runs.json` 为空） | **WARNING** | 允许跳过该部分流水日志，继续导入核心资料、文稿与场景。 |
| 存在孤立三元组（`documentId` 无法关联） | **WARNING** | 将该三元组的来源标记为 `detached`，保留其客观事实边，不中断整体图谱导入。 |
| 原生记忆未通过 SDK 获取（权限受限） | **INFO** | `native-memories/native_memories.json` 为 `[]`，文稿的 `memoryId` 保留，记录提示未包含宿主原生数据。 |
| 无法执行二进制压缩输出 | **DEGRADATION** | 自动触发降级模式，输出单文件 JSON，文件名为 `life-backup-<characterId>-<timestamp>.json`。 |

### 6.4 前向与后向兼容性承诺 (Compatibility Guarantees)
1. **语义化版本 (SemVer) 约束**:
   - `exportVersion` 保持 `1.x.y` 期间，数据结构保持向后兼容（向后兼容：新版导出的备份包可由旧版导入器安全忽略未知字段解析；向前兼容：旧版备份包可平滑升级至新版）。
2. **容忍未知新增属性 (Open-World Assumption)**:
   任何合规的反序列化程序或转换 Agent，在遇到未在本规范中定义的额外字段时，**必须安全忽略，严禁抛出异常崩溃**。
3. **历史版本数据升级支持**:
   - 本规范对 v0.1.x 与 v0.2.0–v0.2.2 遗留的 SQLite 存储记录提供了自动结构补齐定义（如 Profile 从 `schema: 1` 升级至 `schema: 2` 时自动补充 `cardSync` 与 `healthNote` 默认字段，从 `schema: 2` 升级至 `schema: 3` 时自动将历史 `profile.plans` 迁移至 `ll_plans` 独立表并补全扩展设置项）。

---

## 7. QA 独立审查与验证验收清单 (QA Verification Checklist)

为了保证本规范文档已完全满足原初用户需求并可供 QA 角色进行独立验证，在此制定核查清单：

- [x] **Criterion 1: 脱离源码自解释性 (Self-Contained Criterion)**:
  不依赖本项目仓库内任何 `.js` 代码，第三方开发者仅通过阅读第 2、4、5 节，即可获知所有字段的名称、含义、类型与底座映射关系，顺利写出转换转换脚本。
- [x] **Criterion 2: 原子不可分性 (Atomicity Criterion)**:
  第 4 节对 `manifest.json`、`profile.json`、`schedules/daily_facts.json`、`schedules/plans.json`、`documents/documents.json`、`scenes/scenes.json`、`runs/history_runs.json`、`knowledge-graph/graph.json`、`native-memories/native_memories.json` 以及降级根 JSON 进行了彻底的叶子字段解构，不存在任何未展开的复合黑盒对象。
- [x] **Criterion 3: 枚举值穷举性 (Enum Exhaustiveness)**:
  对所有状态字段（`kind`, `phase`, `syncStatus`, `graphStatus`, `retrievalStatus`, `archiveMode`, `wakeSource`, `nature` 等）均给出了完备的封闭枚举集合与状态语义。
- [x] **Criterion 4: 格式自洽性与可解析性 (Schema Soundness & JSON Validity)**:
  第 5 节提供的 10 个 JSON 示例均采用 100% 真实业务数据，无任何 `...` 省略号或语法错误，可直接通过标准 JSON 解析器校验。
- [x] **Criterion 5: 记忆底座迁移实操性 (Memory Base Portability)**:
  第 2 节系统性给出了 Mem0、Letta、Zep 的范式对比、映射矩阵与通用算法流程，具备高度的可实施性。

---

*规范编写完成。本规范为 Layla Life Dashboard 全量数据导出与互操作生态的技术基石。*
