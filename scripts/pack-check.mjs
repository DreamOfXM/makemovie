#!/usr/bin/env node
/**
 * 发布前护栏：这个包是「两条命令读手册 + 两个技能」，不该带别的东西，也不该
 * 带出去一个装不上的技能。
 *
 * 根包同时是 monorepo 的根，所以 package.json 的 `files` 白名单是唯一防线。
 * 它被删掉或写漏时，`npm publish` 会连同 apps/ 与 packages/ 的源码一起推上去
 * ——实测 320 个文件 / 5.8 MB，而白名单在位时是 9 个文件 / 约 45 kB。
 *
 * 检查分四段：包内容白名单、必需文件、技能 frontmatter 合规、`install-skill`
 * 在临时目录里真跑一遍（写两份、覆写一次、dry-run 零写入）。
 *
 * 三处调用：package.json 的 prepublishOnly、CI 的 Pack guard、本地手动排查。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 仓库目录，不属于这个包。
const FORBIDDEN = /^(apps|packages|website|infra|scripts|docs|var|\.aoci|xhs-promo|xhs-preview)\//;

// 手册、命令行入口与两个技能必须真的在包里，否则 npx 出来的是个空壳。
const REQUIRED = [
  'bin/makemovie.mjs',
  'skills/makemovie/SKILL.md',
  'skills/film-production/SKILL.md',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'TRADEMARK.md',
];

// 45 kB 量级；给手册与技能长到十倍留出余量，同时挡住整仓源码那种 5.8 MB。
const MAX_BYTES = 512 * 1024;

const failures = [];

function frontmatter(text) {
  const block = text.match(/^---\n([\s\S]*?)\n---/);
  if (!block) return null;
  const field = (key) => {
    const hit = block[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return hit ? hit[1].trim() : '';
  };
  return { name: field('name'), description: field('description') };
}

// 一、包内容：白名单没有漏、必需文件在、体积没过线。
const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const [report] = JSON.parse(raw);
const paths = report.files.map((file) => file.path);

const offenders = paths.filter((path) => FORBIDDEN.test(path));
if (offenders.length > 0) {
  failures.push(`混入了不属于本包的目录 ${offenders.length} 条，例如 ${offenders.slice(0, 5).join(', ')}`);
}

const missing = REQUIRED.filter((path) => !paths.includes(path));
if (missing.length > 0) {
  failures.push(`缺少必需文件 ${missing.join(', ')}`);
}

if (report.size > MAX_BYTES) {
  failures.push(`压缩包 ${(report.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_BYTES / 1024} kB 上限`);
}

// 二、每个技能：frontmatter 合规、name 与目录同名（宿主要靠这个发现技能）。
const skillDirs = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (skillDirs.length === 0) {
  failures.push('skills/ 下没有任何技能目录');
}

for (const skill of skillDirs) {
  const file = join(ROOT, 'skills', skill, 'SKILL.md');
  if (!existsSync(file)) {
    failures.push(`skills/${skill}/ 没有 SKILL.md`);
    continue;
  }
  const meta = frontmatter(readFileSync(file, 'utf8'));
  if (!meta) {
    failures.push(`skills/${skill}/SKILL.md 没有 YAML frontmatter`);
    continue;
  }
  if (meta.name !== skill) {
    failures.push(`skills/${skill}/SKILL.md 的 name 是 "${meta.name}"，必须与目录同名`);
  }
  if (!meta.description || meta.description.length > 1024) {
    failures.push(`skills/${skill}/SKILL.md 的 description 缺失或超过 1024 字符`);
  }
}

// 三、真跑一遍装机：临时目录里写两份、再覆写一次、dry-run 不许落任何文件。
const tmp = mkdtempSync(join(tmpdir(), 'mm-pack-'));
try {
  const run = (args) =>
    spawnSync(process.execPath, [join(ROOT, 'bin', 'makemovie.mjs'), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
    });

  const first = run(['install-skill', '--dir', tmp]);
  if (first.status !== 0) {
    failures.push(`install-skill 退出码 ${first.status}: ${(first.stderr || '').trim()}`);
  }
  for (const skill of skillDirs) {
    const installed = join(tmp, skill, 'SKILL.md');
    if (!existsSync(installed)) {
      failures.push(`install-skill 没有写出 ${skill}/SKILL.md`);
      continue;
    }
    if (readFileSync(installed, 'utf8') !== readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8')) {
      failures.push(`install-skill 写出的 ${skill}/SKILL.md 与源文件不一致`);
    }
  }

  const again = run(['install-skill', '--dir', tmp]);
  if (again.status !== 0) {
    failures.push(`install-skill 第二次运行（覆写）退出码 ${again.status}`);
  }

  const dryDir = join(tmp, 'dry');
  const dry = run(['install-skill', '--dir', dryDir, '--dry-run']);
  if (dry.status !== 0) {
    failures.push(`install-skill --dry-run 退出码 ${dry.status}`);
  }
  if (existsSync(dryDir) && statSync(dryDir).isDirectory() && readdirSync(dryDir).length > 0) {
    failures.push('install-skill --dry-run 仍然写了文件');
  }

  const print = run(['skill']);
  if (print.status !== 0 || !print.stdout.startsWith('---\nname: makemovie')) {
    failures.push('`makemovie skill` 没有打印出 makemovie 技能正文');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(
    'pack-check 失败：这个包即将发布出去，但内容不对。\n' +
      failures.map((line) => `  - ${line}\n`).join('') +
      '先把根 package.json 的 files 白名单、skills/ 或 bin/makemovie.mjs 修回来。\n',
  );
  process.exit(1);
}

process.stdout.write(
  `pack-check 通过：${paths.length} 个文件 / ${(report.size / 1024).toFixed(1)} kB，` +
    `${skillDirs.length} 个技能装机自检通过\n` +
    paths.map((path) => `  ${path}`).join('\n') +
    '\n',
);
