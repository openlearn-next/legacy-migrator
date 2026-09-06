// frontend.tsx — 旧版数据迁移插件前端（教师端 tab）
// 运行于宿主页面，React 由 HostSharedDeps 提供；JSX 经典转换，组件用 function 声明

import JSZip from 'jszip';
import {
  rewriteResourceRefs,
  chunk,
  chunkBySerializedSize,
  sanitizeRelPath,
} from './shared';

// React 由宿主 HostSharedDeps 注入为全局变量，不可 import（宿主未映射 react 模块）
declare const React: any;

const COMMAND_PREFIX = 'legacymigrator';
const STUDENT_CHUNK_SIZE = 200;
const MEMBERSHIP_CHUNK_SIZE = 500;
const RESOURCE_BATCH_BYTES = 1.5 * 1024 * 1024;
const MAX_SINGLE_RESOURCE_BYTES = 30 * 1024 * 1024;

let ctx: any = null;

const h = React.createElement;

function el(label: string, value: any, warn: boolean) {
  const style: any = { padding: '6px 10px', border: '1px solid #e2e8f0', fontSize: 13 };
  if (warn) {
    style.color = '#b45309';
    style.fontWeight = 700;
  }
  return h('tr', { key: label },
    h('td', { style }, label),
    h('td', { style: { ...style, textAlign: 'right' } }, String(value)));
}

function MainPanel() {
  const [phase, setPhase] = React.useState('idle'); // idle | loaded | importing | done
  const [fileName, setFileName] = React.useState('');
  const [pkg, setPkg] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const [force, setForce] = React.useState(false);
  const [progress, setProgress] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState('');
  const zipRef = React.useRef(null);

  const exportStats = pkg?.stats || {};

  async function handleFile(ev: any) {
    setError('');
    setPreview(null);
    setResult(null);
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    setFileName(file.name);
    try {
      const zip = await JSZip.loadAsync(file);
      const jsonFile = zip.file('legacy-export.json');
      if (!jsonFile) throw new Error('压缩包中找不到 legacy-export.json，请确认来自旧站「导出新平台」页面');
      const data = JSON.parse(await jsonFile.async('string'));
      if (!data || typeof data.schemaVersion !== 'number') throw new Error('导出包格式不正确');
      zipRef.current = zip;
      setPkg(data);
      setPhase('loaded');
      // 服务端冲突预检
      const res = await ctx.invokeCommand(`${COMMAND_PREFIX}.import.preview`, {
        schemaVersion: data.schemaVersion,
        studentNumbers: (data.students || []).map((s: any) => s.studentNumber),
        classNames: (data.classes || []).map((c: any) => c.name),
        courseSourceIds: (data.courses || []).map((c: any) => c.sourceId),
      });
      setPreview(res && res.report);
    } catch (e: any) {
      setPhase('idle');
      setError(e?.message || String(e));
    }
  }

  async function runImport() {
    if (!pkg || !zipRef.current) return;
    setPhase('importing');
    setError('');
    setResult(null);
    const summary: any = {
      classes: 0, students: 0, memberships: 0, resources: 0, courses: 0,
      skippedCourses: 0, errors: [], startedAt: new Date().toISOString(),
    };

    const step = (label: string, done: number, total: number) => setProgress({ label, done, total });

    try {
      // 1. 班级
      step('导入班级', 0, 1);
      const classes = pkg.classes || [];
      const classRes = await ctx.invokeCommand(`${COMMAND_PREFIX}.import.classes`, { classes });
      const classMap: Record<string, string> = (classRes && classRes.map) || {};
      summary.classes = (classRes && classRes.created) || 0;
      summary.classesUpdated = (classRes && classRes.updated) || 0;
      step('导入班级', 1, 1);

      // 2. 学生（分块）
      const students = pkg.students || [];
      const studentMap: Record<string, string> = {};
      let studentErrors: string[] = [];
      const studentChunks = chunk(students, STUDENT_CHUNK_SIZE);
      for (let i = 0; i < studentChunks.length; i++) {
        step(`导入学生（${i + 1}/${studentChunks.length} 批）`, i, studentChunks.length);
        const res = await ctx.invokeCommand(`${COMMAND_PREFIX}.import.students`, { students: studentChunks[i] });
        Object.assign(studentMap, (res && res.map) || {});
        studentErrors = studentErrors.concat((res && res.errors) || []);
        summary.students += (res && res.created) || 0;
        summary.studentsUpdated = (summary.studentsUpdated || 0) + ((res && res.updated) || 0);
      }
      summary.errors = summary.errors.concat(studentErrors);
      step(`导入学生（${studentChunks.length}/${studentChunks.length} 批）`, studentChunks.length, studentChunks.length);

      // 3. 班级-学生关联
      const memberships: any[] = [];
      for (const s of students) {
        const classId = classMap[`${s.grade}.${s.classNo}`];
        const studentId = studentMap[s.studentNumber];
        if (classId && studentId) memberships.push({ classId, studentId });
      }
      const membershipChunks = chunk(memberships, MEMBERSHIP_CHUNK_SIZE);
      for (let i = 0; i < membershipChunks.length; i++) {
        step(`建立班级学生关联（${i + 1}/${membershipChunks.length} 批）`, i, membershipChunks.length);
        const res = await ctx.invokeCommand(`${COMMAND_PREFIX}.import.membership`, { items: membershipChunks[i] });
        summary.memberships += (res && res.added) || 0;
      }

      // 4. 资源文件（全包去重、按体积分批上传到 VFS）
      const refUrlMap = new Map<string, string>();
      const allRefs: any[] = [];
      const seenRef: any = {};
      for (const c of pkg.courses || []) {
        for (const r of c.resources || []) {
          if (r.missing || seenRef[r.ref]) continue;
          seenRef[r.ref] = true;
          allRefs.push(r);
        }
      }
      const uploads = allRefs
        .map((r) => ({ relPath: sanitizeRelPath(String(r.ref).replace(/^resources\//, '')) || '', bytes: r.bytes || 0 }))
        .filter((u) => u.relPath);
      const batches = chunkBySerializedSize(
        uploads.filter((u) => u.bytes <= MAX_SINGLE_RESOURCE_BYTES),
        RESOURCE_BATCH_BYTES,
        (u) => u.bytes,
      );
      for (let i = 0; i < batches.length; i++) {
        step(`迁移课程资源（${i + 1}/${batches.length} 批）`, i, batches.length);
        const items: any[] = [];
        for (const u of batches[i]) {
          const zf = zipRef.current.file('resources/' + u.relPath);
          if (!zf) continue;
          items.push({ relPath: u.relPath, base64: await zf.async('base64') });
        }
        if (items.length === 0) continue;
        const res = await ctx.invokeCommand(`${COMMAND_PREFIX}.import.resources`, { items });
        const urls = (res && res.urls) || {};
        for (const ref of Object.keys(urls)) refUrlMap.set(ref, urls[ref]);
        summary.resources += (res && res.createdFiles) || 0;
        summary.errors = summary.errors.concat((res && res.errors) || []);
      }
      step(`迁移课程资源（${batches.length}/${batches.length} 批）`, batches.length, batches.length);

      // 5. 课程 → courseware 课件
      const courses = pkg.courses || [];
      for (let i = 0; i < courses.length; i++) {
        step(`导入课程课件（${i + 1}/${courses.length}）`, i, courses.length);
        const c = courses[i];
        try {
          const html = rewriteResourceRefs(c.html || '', refUrlMap);
          const res = await ctx.invokeCommand(`${COMMAND_PREFIX}.import.courseware`, {
            sourceId: c.sourceId,
            title: c.title,
            html,
            published: !!c.published,
            term: c.term,
            classScope: c.classScope,
            force,
          });
          if (res && res.skipped) summary.skippedCourses++;
          else summary.courses++;
        } catch (e: any) {
          summary.errors.push(`课程「${c.title}」(${c.sourceId}): ${e?.message || e}`);
        }
      }

      // 6. 收尾 + 审计
      await ctx.invokeCommand(`${COMMAND_PREFIX}.import.finalize`, { summary });
      const status = await ctx.invokeCommand(`${COMMAND_PREFIX}.import.status`, {});
      summary.auditCounts = (status && status.counts) || {};
      setResult(summary);
      setPhase('done');
    } catch (e: any) {
      setError(e?.message || String(e));
      setPhase('loaded');
    } finally {
      setProgress(null);
    }
  }

  async function resetAudit() {
    try {
      await ctx.invokeCommand(`${COMMAND_PREFIX}.import.reset`, {});
      setError('');
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }

  const card: any = { border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, marginBottom: 12, background: '#fff' };
  const btn: any = { padding: '8px 18px', borderRadius: 10, border: 'none', fontWeight: 700, cursor: 'pointer' };

  return h('div', { style: { padding: 20, fontFamily: 'system-ui, sans-serif', color: '#0f172a', overflow: 'auto' } },
    h('h2', { style: { margin: '0 0 4px', fontSize: 20 } }, '📦 旧版数据迁移（LearnSite → OpenLearn-Next）'),
    h('p', { style: { color: '#64748b', fontSize: 13, margin: '0 0 16px' } },
      '上传旧站「导出新平台」页面生成的 ZIP 包。预览确认后执行导入：班级、学生（含密码）、课程课件与图片资源。重复导入是安全的（按学号/班级名/课程来源幂等）。'),

    h('div', { style: card },
      h('div', { style: { marginBottom: 8, fontWeight: 700 } }, '① 选择导出包'),
      h('input', { type: 'file', accept: '.zip', onChange: handleFile }),
      fileName ? h('span', { style: { marginLeft: 8, fontSize: 13, color: '#475569' } }, fileName) : null,
      error ? h('div', { style: { marginTop: 8, color: '#dc2626', fontSize: 13 } }, '⚠️ ' + error) : null),

    phase !== 'idle' && pkg ? h('div', { style: card },
      h('div', { style: { marginBottom: 8, fontWeight: 700 } }, '② 预览'),
      h('table', { style: { borderCollapse: 'collapse', width: '100%' } }, h('tbody', null,
        el('班级', exportStats.classes || 0, false),
        el('学生', exportStats.students || 0, false),
        el('课程课件', exportStats.courses || 0, false),
        el('可迁移资源文件', exportStats.resourceFiles || 0, false),
        preview ? el('其中已存在的学生（将更新）', preview.studentsExisting, false) : null,
        preview ? el('导出包内重复学号', preview.duplicateInExport, preview.duplicateInExport > 0) : null,
        preview ? el('已导入过的课程（默认跳过）', preview.coursesAlreadyImported, preview.coursesAlreadyImported > 0) : null,
        el('缺失资源引用（导出时已标记）', pkg.stats?.missingResources || 0, (pkg.stats?.missingResources || 0) > 0),
      )),
      h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, fontSize: 13 } },
        h('input', { type: 'checkbox', checked: force, onChange: (e: any) => setForce(e.target.checked) }),
        '重新导入已导入过的课程（生成新课件）'),
      h('button', {
        style: { ...btn, marginTop: 12, background: 'linear-gradient(135deg,#2563eb,#1d4ed8)', color: '#fff' },
        onClick: runImport, disabled: phase === 'importing',
      }, phase === 'importing' ? '导入中…' : '③ 开始导入')) : null,

    progress ? h('div', { style: card },
      h('div', { style: { fontWeight: 700, marginBottom: 8 } }, progress.label),
      h('div', { style: { height: 8, background: '#e2e8f0', borderRadius: 4 } },
        h('div', {
          style: {
            height: 8, borderRadius: 4, transition: 'width .2s',
            width: (progress.total ? Math.round((progress.done / progress.total) * 100) : 0) + '%',
            background: 'linear-gradient(90deg,#2563eb,#1d4ed8)',
          },
        }))) : null,

    phase === 'done' && result ? h('div', { style: card },
      h('div', { style: { fontWeight: 700, marginBottom: 8 } }, '④ 导入完成'),
      h('table', { style: { borderCollapse: 'collapse', width: '100%' } }, h('tbody', null,
        el('新增班级', result.classes, false),
        el('新增学生', result.students, false),
        el('建立学生-班级关联', result.memberships, false),
        el('迁移资源文件', result.resources, false),
        el('导入课程课件', result.courses, false),
        el('跳过（已导入过）', result.skippedCourses, false),
      )),
      result.errors && result.errors.length > 0
        ? h('div', { style: { marginTop: 8, fontSize: 12, color: '#b45309' } },
          `⚠️ ${result.errors.length} 条非致命错误：`,
          h('ul', { style: { margin: '4px 0 0 16px' } },
            result.errors.slice(0, 10).map((e: string, i: number) => h('li', { key: i }, e))))
        : h('div', { style: { marginTop: 8, color: '#15803d', fontSize: 13 } }, '✅ 全部成功。课程可在「课件中心」查看，图片资源已改写为新平台 /files/ 路径。')) : null,

    h('div', { style: { fontSize: 12, color: '#94a3b8', display: 'flex', gap: 12 } },
      h('a', { onClick: resetAudit, style: { cursor: 'pointer', textDecoration: 'underline' } }, '清空导入审计记录（不影响已导入数据）'),
      h('span', {}, '审计表用于断点续传判断，清空后重新导入会生成新课件'))
  );
}

async function activate(hostCtx: any) {
  ctx = hostCtx;
  hostCtx.ui.registerExtensionPoint('teacher.tab', {
    id: 'legacy-migrator',
    label: '旧版迁移',
    icon: 'Package',
    component: MainPanel,
    position: 99,
  });
}

function deactivate() {}

export default { activate, deactivate };
