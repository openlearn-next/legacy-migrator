import { describe, expect, it, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import plugin from '../index';

const PLUGIN_ID = '@aymwoo/plugin-legacy-migrator';
const PREFIX = 'plugin_' + PLUGIN_ID.replace(/[^a-zA-Z0-9_]/g, '_') + '_';

const ADMIN_CMD = (payload: any) => ({ actorId: 'user:usr_admin:administrator', payload });

function makeCtx(db: DatabaseSync) {
  const handlers = new Map<string, any>();
  const events: any[] = [];
  const coreHandlers: Record<string, (cmd: any) => any> = {
    // 模拟内核 courseware.upload 的落库行为
    'courseware.upload': (cmd: any) => {
      const { name, filename } = cmd.payload;
      const id = 'cw_' + Math.random().toString(16).slice(2, 18);
      db.prepare('INSERT INTO courseware (id, uuid, name, type, entry, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id, 'uuid-' + id, name, 'html', filename, Date.now(),
      );
      return { coursewareId: id };
    },
  };
  const ctx = {
    services: {
      commandBus: {
        registerHandler: async (type: string, handler: any) => {
          // 模拟宿主 wrapCommandBus：非内核插件注册的命令自动加 manifest.id 前缀
          handlers.set(PLUGIN_ID + '.' + type, handler);
        },
        createCommand: (type: string, payload: any, actorId: string, metadata?: any) => ({
          id: 'cmd_' + Math.random().toString(36).slice(2),
          type,
          payload,
          actorId,
          metadata,
        }),
        execute: async (cmd: any) => {
          if (coreHandlers[cmd.type]) return coreHandlers[cmd.type](cmd);
          const h = handlers.get(cmd.type);
          if (!h) throw new Error('No handler registered for command: ' + cmd.type);
          return h.execute(cmd);
        },
      },
      eventBus: { publish: async (e: any) => events.push(e) },
    },
    resolve: async (token: any) => {
      if (token.name === '@openlearn/core:IDatabase') return db;
      throw new Error('token 未注册: ' + token.name);
    },
    db: {
      ensureTable: async (name: string, schema: string) => {
        db.exec(`CREATE TABLE IF NOT EXISTS ${PREFIX}${name} (${schema})`);
      },
      table: (name: string) => PREFIX + name,
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { ctx, handlers, events };
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE classes (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, class_passcode TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE students (id TEXT PRIMARY KEY, student_number TEXT UNIQUE, name TEXT NOT NULL, email TEXT, password TEXT, locked_lesson_id TEXT, private_notes TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE class_students (class_id TEXT NOT NULL, student_id TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (class_id, student_id));
    CREATE TABLE vfs_nodes (id TEXT PRIMARY KEY, parent_id TEXT, type TEXT NOT NULL, name TEXT NOT NULL, content TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE courseware (id TEXT PRIMARY KEY, uuid TEXT UNIQUE NOT NULL, name TEXT NOT NULL, type TEXT, entry TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  return db;
}

describe('legacy-migrator 导入链路（集成）', () => {
  let db: DatabaseSync;
  let handlers: Map<string, any>;
  let events: any[];

  beforeAll(async () => {
    db = makeDb();
    const ctx = makeCtx(db);
    handlers = ctx.handlers;
    events = ctx.events;
    await (plugin as any).activate(ctx.ctx);
  });

  const call = async (type: string, payload: any) =>
    handlers.get(`@aymwoo/plugin-legacy-migrator.legacymigrator.${type}`).execute(ADMIN_CMD(payload));

  it('preview 校验 schema 版本', async () => {
    await expect(call('import.preview', { schemaVersion: 99 })).rejects.toThrow(/schema 版本不匹配/);
    const r = await call('import.preview', { schemaVersion: 1, studentNumbers: [], classNames: [], courseSourceIds: [] });
    expect(r.ok).toBe(true);
  });

  it('班级导入幂等', async () => {
    const classes = [
      { name: '3.2', grade: 3, classNo: 2, passcode: '1234' },
      { name: '3.3', grade: 3, classNo: 3 },
    ];
    const first = await call('import.classes', { classes });
    expect(first.created).toBe(2);
    expect(Object.keys(first.map)).toHaveLength(2);
    const again = await call('import.classes', { classes });
    expect(again.created).toBe(0);
    expect(again.updated).toBe(2);
    expect(Object.keys(again.map)).toHaveLength(2);
    expect(again.map['3.2']).toBe(first.map['3.2']);
    const row = db.prepare('SELECT class_passcode FROM classes WHERE name = ?').get('3.2')!;
    expect(row.class_passcode).toBe('1234');
  });

  it('学生导入幂等且密码更新', async () => {
    const students = [
      { studentNumber: 'S2026001', name: '张三', password: 'abc', grade: 3, classNo: 2 },
      { studentNumber: 'S2026002', name: '李四', password: 'def', grade: 3, classNo: 2 },
    ];
    const first = await call('import.students', { students });
    expect(first.created).toBe(2);
    expect(first.map['S2026001']).toBeTruthy();
    const again = await call('import.students', {
      students: [{ studentNumber: 'S2026001', name: '张三', password: 'newpwd', grade: 3, classNo: 2 }],
    });
    expect(again.created).toBe(0);
    expect(again.updated).toBe(1);
    const pwd = db.prepare('SELECT password FROM students WHERE student_number = ?').get('S2026001')!;
    expect(pwd.password).toBe('newpwd');
  });

  it('班级-学生关联幂等', async () => {
    const classId = db.prepare('SELECT id FROM classes WHERE name = ?').get('3.2')!.id;
    const studentId = db.prepare('SELECT id FROM students WHERE student_number = ?').get('S2026001')!.id;
    const first = await call('import.membership', { items: [{ classId, studentId }] });
    expect(first.added).toBe(1);
    const again = await call('import.membership', { items: [{ classId, studentId }] });
    expect(again.added).toBe(0);
  });

  it('资源写入 VFS（含中文目录），重复上传跳过，非法路径报错', async () => {
    const items = [
      { relPath: 'images/logo.png', base64: 'iVBORw0KGgo=' },
      { relPath: 'docs/课件 2024/讲义.pdf', base64: 'JVBERi0=' },
    ];
    const first = await call('import.resources', { items });
    expect(first.createdFiles).toBe(2);
    expect(first.urls['resources/images/logo.png']).toBe('/files/legacy/images/logo.png');
    expect(first.urls['resources/docs/课件 2024/讲义.pdf']).toBe('/files/legacy/docs/课件 2024/讲义.pdf');
    const again = await call('import.resources', { items });
    expect(again.createdFiles).toBe(0);
    expect(again.skippedExisting).toBe(2);
    // 验证目录链完整：root(legacy) → docs → 课件 2024 → file
    const root = db.prepare('SELECT id FROM vfs_nodes WHERE parent_id IS NULL AND name = ?').get('legacy')!;
    expect(root.id).toBeTruthy();
    const evil = await call('import.resources', { items: [{ relPath: '../evil.png', base64: 'eg==' }] });
    expect(evil.errors[0]).toMatch(/非法资源路径/);
    // /files 解析链可达该文件
    const docs = db.prepare('SELECT id FROM vfs_nodes WHERE parent_id = ? AND name = ? AND type = ?').get(root.id, 'docs', 'dir')!;
    expect(docs.id).toBeTruthy();
  });

  it('课程导入走 courseware.upload，重放默认跳过，force 重建', async () => {
    const payload = {
      sourceId: '12', title: '第一课 认识计算机', html: '<p>hello</p><img src="/files/legacy/images/logo.png">',
      published: true, term: 3, classScope: '3.2;3.3',
    };
    const first = await call('import.courseware', payload);
    expect(first.skipped).toBe(false);
    expect(first.coursewareId).toMatch(/^cw_/);
    const row = db.prepare('SELECT name, type FROM courseware WHERE id = ?').get(first.coursewareId)!;
    expect(row.name).toBe('第一课 认识计算机');
    expect(row.type).toBe('html');
    const again = await call('import.courseware', payload);
    expect(again.skipped).toBe(true);
    expect(again.coursewareId).toBe(first.coursewareId);
    const forced = await call('import.courseware', { ...payload, force: true });
    expect(forced.skipped).toBe(false);
    // 课件导入事件已发布
    expect(events.some((e) => e.type === 'legacymigrator.courseware.imported')).toBe(true);
  });

  it('finalize 发布完成事件且审计可查', async () => {
    await call('import.finalize', { summary: { courses: 1 } });
    expect(events.some((e) => e.type === 'legacymigrator.import.completed')).toBe(true);
    const status = await call('import.status', {});
    expect(status.counts.finalize).toBe(1);
    expect(status.counts.courseware).toBeGreaterThanOrEqual(1);
  });

  it('拒绝非教师/管理员身份', async () => {
    const h = handlers.get('@aymwoo/plugin-legacy-migrator.legacymigrator.import.classes');
    await expect(h.execute({ actorId: 'anonymous', payload: { classes: [] } })).rejects.toThrow(/教师或管理员/);
    await expect(h.execute({ actorId: 'user:stu1:student', payload: { classes: [] } })).rejects.toThrow(/教师或管理员/);
  });
});
