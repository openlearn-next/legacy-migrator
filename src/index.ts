import type { PluginContext } from '@openlearn/plugin-sdk';
import {
  EXPORT_SCHEMA_VERSION,
  LEGACY_VFS_ROOT,
  sanitizeRelPath,
  htmlToMarkdown,
} from './shared';

/**
 * 运行时零 SDK 值导入：SDK CLI 会把 @openlearn/plugin-sdk 打进 bundle，
 * 而其 dist 依赖宿主才有的 pino/express 等模块，独立构建必然失败。
 * DI 容器按 Token.name 字符串匹配，本地等价 Token 即可（与 SDK Token 结构兼容是平台明确设计）。
 */
class Token<T = unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  readonly __serviceType?: T;
  readonly name: string;
  readonly version = '1.0.0';
  constructor(name: string) {
    this.name = name;
  }
}
const ICommandBusServiceToken = new Token('@openlearn/core:ICommandBusService');
const IEventBusServiceToken = new Token('@openlearn/core:IEventBusService');
const IDatabaseToken = new Token('@openlearn/core:IDatabase');

const PLUGIN_COMMAND_PREFIX = 'legacymigrator';
const STUDENT_CHUNK_SIZE = 200;
const MEMBERSHIP_CHUNK_SIZE = 500;
const RESOURCE_BATCH_BYTES = 1.5 * 1024 * 1024;

type AnyDb = {
  prepare: (sql: string) => {
    run: (...params: any[]) => any;
    get: (...params: any[]) => any;
    all: (...params: any[]) => any[];
  };
  exec: (sql: string) => void;
};

interface LegacyClass {
  name: string;
  grade: string | number;
  classNo: string | number;
  passcode?: string;
}

interface LegacyStudent {
  studentNumber: string;
  name: string;
  password?: string;
  grade?: string | number;
  classNo?: string | number;
}

interface LegacyResourceUpload {
  relPath: string;
  base64: string;
}

export default {
  manifest: {
    id: '@aymwoo/plugin-legacy-migrator',
    name: '旧版数据迁移',
    version: '0.2.1',
    description: '将旧版 LearnSite 导出包（班级/学生/课程及资源文件）导入 openlearn-next，支持 dry-run 预览、幂等重放与导入审计',
    author: 'WuXiangfeng',
    engines: { openlearn: '>=0.2.5' },
    requires: [
      '@openlearn/core:ICommandBusService@^1.0.0',
      '@openlearn/core:IEventBusService@^1.0.0',
      '@openlearn/core:IDatabase@^1.0.0',
    ],
    capabilitiesProposed: [
      'class:read', 'class:write', 'student:read', 'student:write',
      'lesson:read', 'lesson:write',
    ],
  },

  async activate(ctx: PluginContext) {
    const commandBus = ctx.services.commandBus;
    const eventBus = ctx.services.eventBus;
    const db = (await ctx.resolve(IDatabaseToken)) as AnyDb;

    // 执行模式自检：worker 模式下 DB 是异步 RPC 代理（all() 返回 Promise 而非数组），
    // 且核心表黑名单禁止本插件所需的 classes/students/courseware 写入——必须 inline 运行。
    const probe = db.prepare('SELECT 1 AS x').all();
    if (!Array.isArray(probe)) {
      throw new Error(
        '旧版数据迁移插件必须以 inline 执行模式运行（当前为 worker 模式）。' +
          '请在插件中心重新上传插件包并选择 inline 模式，' +
          "或直接在宿主数据库执行 UPDATE plugins SET execution_mode = 'inline' 后重启服务。",
      );
    }

    // 插件自有审计表（命名空间隔离）：每次导入动作一行，卸载插件时自动清理
    await ctx.db.ensureTable(
      'import_batches',
      `id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       source_key TEXT,
       target_id TEXT,
       detail TEXT,
       created_at INTEGER NOT NULL`,
    );
    const batchTable = ctx.db.table('import_batches');

    const now = () => Date.now();
    const uuid = () =>
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `id_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    /** 迁移命令只允许教师/管理员触发（actorId 形如 user:<id>:<role>） */
    function assertPrivileged(command: any) {
      const actorId: string = command?.actorId || '';
      const m = /^user:.+:(.+)$/.exec(actorId);
      if (!m || (m[1] !== 'administrator' && m[1] !== 'teacher')) {
        throw new Error('旧版数据迁移命令需要教师或管理员身份');
      }
    }

    function recordBatch(kind: string, sourceKey: string, targetId: string, detail: any = null) {
      db.prepare(
        `INSERT INTO ${batchTable} (id, kind, source_key, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(uuid(), kind, sourceKey, targetId, detail ? JSON.stringify(detail) : null, now());
    }

    async function publishEvent(type: string, payload: any) {
      await eventBus.publish({
        id: uuid(),
        type,
        source: PLUGIN_COMMAND_PREFIX,
        payload,
        timestamp: now(),
      } as any);
    }

    function ensureDirRow(parentId: string | null, name: string): string {
      const existing = db
        .prepare('SELECT id FROM vfs_nodes WHERE parent_id IS ? AND name = ? AND type = ?')
        .get(parentId, name, 'dir');
      if (existing?.id) return existing.id;
      const id = uuid();
      db.prepare(
        'INSERT INTO vfs_nodes (id, parent_id, type, name, content, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
      ).run(id, parentId, 'dir', name, now(), now());
      return id;
    }

    /** 在 /files/legacy/... 下写入一个文件（幂等：已存在则跳过），返回可访问 URL */
    function writeVfsFile(relPath: string, base64: string): { url: string; created: boolean } {
      const clean = sanitizeRelPath(relPath);
      if (!clean) throw new Error(`非法资源路径: ${relPath}`);
      const segments = clean.split('/');
      const fileName = segments[segments.length - 1];
      let parentId: string | null = null;
      for (const seg of [LEGACY_VFS_ROOT, ...segments.slice(0, -1)]) {
        parentId = ensureDirRow(parentId, seg);
      }
      const existingFile = db
        .prepare('SELECT id FROM vfs_nodes WHERE parent_id IS ? AND name = ? AND type = ?')
        .get(parentId, fileName, 'file');
      const url = '/files/' + LEGACY_VFS_ROOT + '/' + clean;
      if (existingFile?.id) return { url, created: false };
      db.prepare(
        'INSERT INTO vfs_nodes (id, parent_id, type, name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(uuid(), parentId, 'file', fileName, base64, now(), now());
      return { url, created: true };
    }

    /** 为一门课程补建/幂等获取课程条目（lesson），供导入与"课件已存在补建课程"两条路径共用 */
    async function ensureLessonForCourse(
      p: { sourceId: string; title: string; html: string; force?: boolean },
      actorId: string,
    ): Promise<{ lessonId?: string; lessonSkipped: boolean; lessonError?: string }> {
      const prevLesson = db
        .prepare(`SELECT target_id FROM ${batchTable} WHERE kind = 'lesson' AND source_key = ? ORDER BY created_at DESC`)
        .get(p.sourceId);
      if (prevLesson?.target_id && !p.force) {
        return { lessonId: prevLesson.target_id, lessonSkipped: true };
      }
      try {
        const md = htmlToMarkdown(p.html);
        const content = [
          `> 本课程由旧版 LearnSite 迁移而来（来源编号 ${p.sourceId}）。`,
          `> 完整交互内容请打开同名 HTML 课件「${p.title}」（系统资源库），课程页图片即该课件的资源文件。`,
          '',
          md,
        ].join('\n');
        const lcmd = await commandBus.createCommand(
          'lesson.create',
          { title: p.title, content },
          actorId,
          { approved: true },
        );
        const lr: any = await commandBus.execute(lcmd);
        const lessonId = lr?.lessonId ?? lr?.result?.lessonId;
        if (lessonId) {
          recordBatch('lesson', p.sourceId, lessonId, { title: p.title });
          const scmd = await commandBus.createCommand(
            'lesson.add_segment',
            {
              lessonId,
              title: '互动练习',
              duration: '40m',
              type: 'practice',
              notes: `打开本课迁移的 HTML 课件「${p.title}」（系统资源库）进行互动教学`,
            },
            actorId,
            { approved: true },
          );
          await commandBus.execute(scmd);
        }
        return { lessonId, lessonSkipped: false };
      } catch (e: any) {
        const msg = String(e?.message || e);
        recordBatch('lesson_error', p.sourceId, '', msg);
        return { lessonSkipped: false, lessonError: msg };
      }
    }

    // ── 1. dry-run 预览：只读，不发任何写语句 ─────────────────
    await commandBus.registerHandler(`${PLUGIN_COMMAND_PREFIX}.import.preview`, {
      async execute(command: any) {
        assertPrivileged(command);
        const payload = command.payload as {
          schemaVersion?: number;
          studentNumbers?: string[];
          classNames?: string[];
          courseSourceIds?: string[];
        };
        if (payload?.schemaVersion !== EXPORT_SCHEMA_VERSION) {
          throw new Error(`导出包 schema 版本不匹配（期望 ${EXPORT_SCHEMA_VERSION}，收到 ${payload?.schemaVersion}），请使用旧站最新的导出页面`);
        }
        const existingNumbers = new Set(
          db.prepare('SELECT student_number FROM students WHERE student_number IS NOT NULL').all()
            .map((r: any) => String(r.student_number)),
        );
        const existingClassNames = new Set(
          db.prepare('SELECT name FROM classes').all().map((r: any) => String(r.name)),
        );
        const importedCourseIds = new Set(
          db.prepare(`SELECT source_key FROM ${batchTable} WHERE kind = 'courseware' AND source_key IS NOT NULL`)
            .all()
            .map((r: any) => String(r.source_key)),
        );
        const numbers = payload.studentNumbers || [];
        const duplicateInExport = numbers.length - new Set(numbers.map(String)).size;
        const studentsExisting = numbers.filter((n) => existingNumbers.has(String(n))).length;
        const classesExisting = (payload.classNames || []).filter((n) => existingClassNames.has(String(n))).length;
        const coursesAlreadyImported = (payload.courseSourceIds || [])
          .map(String)
          .filter((id) => importedCourseIds.has(id)).length;
        return {
          ok: true,
          report: {
            studentsTotal: numbers.length,
            studentsNew: numbers.length - studentsExisting,
            studentsExisting,
            duplicateInExport,
            classesExisting,
            coursesAlreadyImported,
          },
        };
      },
    });

    // ── 2. 班级导入（按 name 幂等）───────────────────────────
    await commandBus.registerHandler(`${PLUGIN_COMMAND_PREFIX}.import.classes`, {
      async execute(command: any) {
        assertPrivileged(command);
        const classes: LegacyClass[] = command.payload?.classes || [];
        const map: Record<string, string> = {};
        let created = 0;
        let updated = 0;
        for (const c of classes) {
          if (!c?.name) continue;
          const existing = db.prepare('SELECT id FROM classes WHERE name = ?').get(c.name);
          if (existing?.id) {
            map[c.name] = existing.id;
            updated++;
            continue;
          }
          const id = uuid();
          db.prepare(
            'INSERT INTO classes (id, name, description, class_passcode, created_at) VALUES (?, ?, ?, ?, ?)',
          ).run(id, c.name, 'LearnSite 迁移导入', c.passcode || null, now());
          map[c.name] = id;
          recordBatch('classes', c.name, id, { grade: c.grade, classNo: c.classNo });
          created++;
        }
        return { ok: true, map, created, updated };
      },
    });

    // ── 3. 学生导入（按 student_number 幂等，密码同步更新）────
    await commandBus.registerHandler(`${PLUGIN_COMMAND_PREFIX}.import.students`, {
      async execute(command: any) {
        assertPrivileged(command);
        const students: LegacyStudent[] = command.payload?.students || [];
        const map: Record<string, string> = {};
        let created = 0;
        let updated = 0;
        const errors: string[] = [];
        for (const s of students) {
          if (!s?.studentNumber || !s?.name) {
            errors.push(`跳过缺少学号或姓名的学生记录: ${JSON.stringify(s).slice(0, 60)}`);
            continue;
          }
          const existing = db
            .prepare('SELECT id FROM students WHERE student_number = ?')
            .get(s.studentNumber);
          if (existing?.id) {
            db.prepare('UPDATE students SET name = ?, password = ? WHERE id = ?').run(
              s.name,
              s.password ?? null,
              existing.id,
            );
            map[s.studentNumber] = existing.id;
            updated++;
            continue;
          }
          const id = uuid();
          db.prepare(
            'INSERT INTO students (id, student_number, name, password, created_at) VALUES (?, ?, ?, ?, ?)',
          ).run(id, s.studentNumber, s.name, s.password ?? null, now());
          map[s.studentNumber] = id;
          recordBatch('students', s.studentNumber, id);
          created++;
        }
        return { ok: true, map, created, updated, errors };
      },
    });

    // ── 4. 班级-学生关联（幂等）───────────────────────────────
    await commandBus.registerHandler(`${PLUGIN_COMMAND_PREFIX}.import.membership`, {
      async execute(command: any) {
        assertPrivileged(command);
        const items: Array<{ classId: string; studentId: string }> = command.payload?.items || [];
        let added = 0;
        for (const item of items) {
          if (!item?.classId || !item?.studentId) continue;
          const exists = db
            .prepare('SELECT 1 AS x FROM class_students WHERE class_id = ? AND student_id = ?')
            .get(item.classId, item.studentId);
          if (exists) continue;
          db.prepare('INSERT INTO class_students (class_id, student_id, joined_at) VALUES (?, ?, ?)').run(
            item.classId,
            item.studentId,
            now(),
          );
          added++;
        }
        return { ok: true, added };
      },
    });

    // ── 5. 资源文件批量写入 VFS（幂等，返回 ref→URL 映射）─────
    await commandBus.registerHandler(`${PLUGIN_COMMAND_PREFIX}.import.resources`, {
      async execute(command: any) {
        assertPrivileged(command);
        const items: LegacyResourceUpload[] = command.payload?.items || [];
        const urls: Record<string, string> = {};
        let createdFiles = 0;
        let skippedExisting = 0;
        const errors: string[] = [];
        for (const item of items) {
          try {
            const { url, created } = writeVfsFile(item.relPath, item.base64);
            urls['resources/' + sanitizeRelPath(item.relPath)] = url;
            if (created) {
              createdFiles++;
              recordBatch('resource', item.relPath, url);
            } else {
              skippedExisting++;
            }
          } catch (e: any) {
            errors.push(`资源 ${item.relPath}: ${e?.message || e}`);
          }
        }
        return { ok: true, urls, createdFiles, skippedExisting, errors };
      },
    });

    // ── 6. 课程 → courseware 课件（复用平台 courseware.upload 写盘）─
    await commandBus.registerHandler(`${PLUGIN_COMMAND_PREFIX}.import.courseware`, {
      async execute(command: any) {
        assertPrivileged(command);
        const p = command.payload as {
          sourceId: string;
          title: string;
          html: string;
          published?: boolean;
          term?: number;
          classScope?: string;
          force?: boolean;
          /** 同时在课程列表创建课程（默认 true）：正文为 Markdown 转换 + 指向 HTML 课件的课堂环节 */
          createLesson?: boolean;
        };
        if (!p?.sourceId || !p?.title || typeof p.html !== 'string') {
          throw new Error('课程导入缺少 sourceId/title/html');
        }
        const previous = db
          .prepare(`SELECT target_id FROM ${batchTable} WHERE kind = 'courseware' AND source_key = ? ORDER BY created_at DESC`)
          .get(p.sourceId);
        if (previous?.target_id && !p.force) {
          // 课件已存在：跳过课件重传，但仍补建缺失的课程条目（课程与课件独立幂等）
          let lessonId: string | undefined;
          let lessonSkipped = false;
          if (p.createLesson !== false) {
            const lr = await ensureLessonForCourse(p, command.actorId);
            lessonId = lr.lessonId;
            lessonSkipped = lr.lessonSkipped;
          }
          return { ok: true, skipped: true, coursewareId: previous.target_id, lessonId, lessonSkipped };
        }
        const base64Data = Buffer.from(p.html, 'utf8').toString('base64');
        const cmd = await commandBus.createCommand(
          'courseware.upload',
          { name: p.title, filename: `learnsite_${p.sourceId}.html`, base64Data },
          command.actorId,
          { approved: true },
        );
        const result: any = await commandBus.execute(cmd);
        // 0.2.x/0.3.x 的 courseware.upload 返回 { success, id, uuid, name, entry }
        const rid =
          result?.id ?? result?.coursewareId ?? result?.result?.id ?? result?.result?.coursewareId;
        const coursewareId = rid || `cw_legacy_${p.sourceId}`;
        recordBatch('courseware', p.sourceId, coursewareId, {
          title: p.title,
          term: p.term,
          classScope: p.classScope,
          published: !!p.published,
          bytes: p.html.length,
        });

        // —— 双写：在课程列表创建同名课程（可关闭）——
        let lessonId: string | undefined;
        let lessonSkipped = false;
        if (p.createLesson !== false) {
          const lr = await ensureLessonForCourse(p, command.actorId);
          lessonId = lr.lessonId;
          lessonSkipped = lr.lessonSkipped;
        }

        await publishEvent(
          'legacymigrator.courseware.imported',
          { sourceId: p.sourceId, coursewareId, lessonId, title: p.title },
        );
        return { ok: true, skipped: false, coursewareId, lessonId, lessonSkipped };
      },
    });

    // ── 7. 收尾：写入汇总 + 发布完成事件 ─────────────────────
    await commandBus.registerHandler(`${PLUGIN_COMMAND_PREFIX}.import.finalize`, {
      async execute(command: any) {
        assertPrivileged(command);
        const summary = command.payload?.summary || {};
        recordBatch('finalize', 'run', '', summary);
        await publishEvent('legacymigrator.import.completed', summary);
        return { ok: true };
      },
    });

    // ── 8. 审计查询 / 重置 ────────────────────────────────────
    await commandBus.registerHandler(`${PLUGIN_COMMAND_PREFIX}.import.status`, {
      async execute(command: any) {
        assertPrivileged(command);
        const rows = db
          .prepare(`SELECT kind, source_key, target_id, detail, created_at FROM ${batchTable} ORDER BY created_at DESC LIMIT 500`)
          .all();
        const counts: Record<string, number> = {};
        for (const r of rows as any[]) counts[r.kind] = (counts[r.kind] || 0) + 1;
        return { ok: true, counts, rows };
      },
    });

    await commandBus.registerHandler(`${PLUGIN_COMMAND_PREFIX}.import.reset`, {
      async execute(command: any) {
        assertPrivileged(command);
        db.prepare(`DELETE FROM ${batchTable}`).run();
        return { ok: true };
      },
    });

    ctx.log.info('旧版数据迁移插件已激活，命令前缀: ' + PLUGIN_COMMAND_PREFIX);
  },

  async deactivate() {
    // 无长驻资源需要清理；审计表随插件卸载由 PluginHost 自动删除
  },
};
