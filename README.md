# openlearn-plugin-legacy-migrator

将旧版 LearnSite（ASP.NET 版 openlearnsite）的班级、学生、课程数据导入 openlearn-next 的独立迁移插件。

## 架构

```
旧站 manager/export_openlearn_next.aspx          本插件（teacher.tab）
learnsite SQL Server ──→ learnsite_to_openlearn_next_*.zip ──上传──→ dry-run 预览 → 分块导入
                         (legacy-export.json + resources/)            ↓
                                                        classes/students/class_students 表
                                                        courseware 课件(复用 courseware.upload)
                                                        vfs_nodes 资源(/files/legacy/...)
```

## 数据映射

| 旧站 | 新平台 | 说明 |
|---|---|---|
| `Room`（Rgrade.Rclass） | `classes.name` / `class_passcode` | 名称沿用旧站"年级.班号"惯例 |
| `Students.Snum/Sname/Spwd` | `students.student_number/name/password` | 按 student_number 幂等，密码明文直迁 |
| `Students.Sgrade+Sclass` | `class_students` 关联 | |
| `Courses.Ctitle/Ccontent` | `courseware`（HTML 课件） | 复用平台 `courseware.upload`，内容原样保留 |
| 课程 HTML 内 `/images/...` 等资源 | `vfs_nodes` → `/files/legacy/...` | 导出时已改写为 `resources/...`，导入时改写为 `/files/legacy/...` |

不迁移：学生小组/成绩字段（新平台无对应结构）、指向旧站 .aspx 页面的内部链接、外部链接。

## 使用步骤

1. **旧站导出**：旧站管理后台 → 导出新平台 → 「统计预览」核对 → 「导出 ZIP 包」。
2. **新站导入**：新平台教师端 → 「旧版迁移」标签页 → 上传 ZIP → 核对预览 → 「开始导入」。
3. 重复导入安全：班级按名称、学生按学号、资源按路径幂等；已导入课程默认跳过（可勾选强制重建）。

## 开发

```bash
npm install
npm test                      # 共享纯函数单测
npx @openlearn/plugin-sdk build   # 产出 dist/index.js + dist/frontend.js + zip
```

构建检查：

```bash
grep -E '^import .+ from "[^@\./]' dist/index.js   # 应无输出（无非法裸导入）
grep -c 'jsx-runtime' dist/frontend.js             # 应为 0（经典 JSX）
```

## 依赖与约束

- 插件必须以 **inline 模式**运行（manifest 未声明 `executionMode: 'worker'` 即默认 inline）。
  worker 沙箱黑名单禁止访问 classes/students/lessons 等核心表。
- 服务端命令均校验 `command.actorId` 为教师/管理员。
- 命令前缀 `legacymigrator.`，事件 `legacymigrator.courseware.imported` / `legacymigrator.import.completed`。
- 导入审计存于插件自有表 `import_batches`（卸载插件时自动清理），课程断点续传依赖它。

## 已知限制

- 课程 HTML 中指向旧站动态页面（.aspx）的链接迁移后为死链。
- 资源单文件上限 30MB、总量 500MB（旧站导出页限制），超出部分跳过并在导出预览中列出。
- 课件以上传时的 HTML 快照导入，旧站后续修改不会自动同步。
