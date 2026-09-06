# Changelog

本文件记录 `@aymwoo/plugin-legacy-migrator` 的变更，遵循 Keep a Changelog 规范。

## [Unreleased]

## [0.2.0] - 2026-09-06

### Added

- **课程双写**：`import.courseware` 新增 `createLesson`（默认开）——除 HTML 课件外，同时在课程列表创建同名课程，正文为轻量 HTML→Markdown 转换（标题/列表/加粗斜体/图片/链接，图片保留 `/files/legacy/...` 改写路径，react-markdown 可直接渲染），并自动添加一个指向 HTML 课件的"互动练习"课堂环节。解决"导入后课程列表看不到旧课程"的问题。幂等：lesson 按 sourceId 断点续传，`force` 时随课件重建。
- manifest 增补 `lesson:read`/`lesson:write` 能力声明。

## [0.1.4] - 2026-09-06

### Fixed

- 修正课程导入的审计记录：宿主 `courseware.upload` 实际返回 `{ success, id, uuid, ... }`，此前取 `coursewareId` 字段落空导致审计表记录兜底占位 ID。经 npm 发行版 0.3.2 真实宿主端到端验收发现并修复（同时完整验证了 preview/classes/students/membership/resources/courseware/finalize 全链路、幂等重放与 /files 资源服务）。

## [0.1.3] - 2026-09-06

### Fixed

- 激活时自检执行模式：宿主以 worker 模式安装本插件时，DB 接口为异步 RPC 代理且核心表黑名单禁止迁移写入，此前会在导入中途报难以理解的 `db.prepare(...).all(...).map is not a function`。现在 activate 阶段即探测并抛出明确的中文错误与修复指引（重装选 inline，或 `UPDATE plugins SET execution_mode = 'inline'` 后重启）。

## [0.1.2] - 2026-09-06

### Fixed

- 放宽 `engines.openlearn` 为 `>=0.2.5`：npm 发行版宿主（openlearn-next@0.2.5）安装时因版本声明过紧被拒。插件依赖的 IDatabase/ICommandBus/IEventBus 服务在 0.2.5 均已存在（与内置教务管理插件同一套 API），0.2.5 及以上宿主均可正常安装运行。

## [0.1.1] - 2026-09-06

### Changed

- 确认与旧站跨平台导出页（learnsite `manager/export_openlearn_next.aspx`，2026-09-06 及之后版本）的配套契约：导出包 zip 条目名带 UTF-8 EFS 标志，中文资源路径（如 `resources/课件/讲义.pdf`）在导入端经 JSZip 正确解析并改写为 `/files/legacy/...`。已通过 Mono 生成 → unzip 解压 → JSZip 读取的全链路实测。
- README 补充导出页版本要求与 inline 执行模式说明。

### Fixed

- 无插件代码变更；本版本为配套旧站导出页跨平台修复（SetLevel 编译错误、Linux 路径守卫、zip 中文乱码）的同步发布。

## [0.1.0] - 2026-09-06

### Features

- 教师端「旧版迁移」标签页：上传旧站导出 ZIP → 预览冲突统计 → 分块导入 → 进度与结果报告
- 服务端命令：`legacymigrator.import.preview/classes/students/membership/resources/courseware/finalize/status/reset`
- 班级按名称幂等、学生按学号幂等（密码同步更新）、资源按路径幂等写入 VFS
- 课程导入复用平台 `courseware.upload`，HTML 内 `resources/...` 引用改写为 `/files/legacy/...`
- 导入审计表 `import_batches` 支持断点续传；命令均校验教师/管理员身份
- 资源批量上传按序列化体积分批（≤1.5MB/命令），规避平台 10MB 请求体限制
