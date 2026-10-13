#!/usr/bin/env node
/**
 * 发布前护栏：断言 npm 包内只有「一条命令读手册」该带的东西。
 *
 * 根包同时是 monorepo 的根，所以 package.json 的 `files` 白名单是唯一防线。
 * 它被删掉或写漏时，`npm publish` 会连同 apps/ 与 packages/ 的源码一起推上去
 * ——实测 320 个文件 / 5.8 MB，而白名单在位时是 6 个文件 / 约 37 kB，差 160 倍，
 * 而且包名还叫「跑一条命令读一千词手册」。
 *
 * 三处调用：package.json 的 prepublishOnly、CI 的 Pack guard、本地手动排查。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 仓库目录，不属于这个包。
const FORBIDDEN = /^(apps|packages|website|infra|scripts|docs|var|\.aoci|xhs-promo|xhs-preview)\//;

// 手册与 agent 入口必须真的在包里，否则 npx 出来的是个空壳。
const REQUIRED = ['bin/makemovie.mjs', 'skills/makemovie/SKILL.md'];

// 38 kB 量级；给手册长到十倍留出余量，同时挡住整仓源码那种 5.8 MB。
const MAX_BYTES = 512 * 1024;

const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const [report] = JSON.parse(raw);
const paths = report.files.map((file) => file.path);

const failures = [];

const offenders = paths.filter((path) => FORBIDDEN.test(path));
if (offenders.length > 0) {
  failures.push(
    `混入了不属于本包的目录 ${offenders.length} 条，例如 ${offenders.slice(0, 5).join(', ')}`,
  );
}

const missing = REQUIRED.filter((path) => !paths.includes(path));
if (missing.length > 0) {
  failures.push(`缺少必需文件 ${missing.join(', ')}`);
}

if (report.size > MAX_BYTES) {
  failures.push(`压缩包 ${(report.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_BYTES / 1024} kB 上限`);
}

if (failures.length > 0) {
  process.stderr.write(
    'pack-check 失败：这个包即将发布出去，但内容不对。\n' +
      failures.map((line) => `  - ${line}\n`).join('') +
      "先把根 package.json 的 files 白名单修回来。\n",
  );
  process.exit(1);
}

process.stdout.write(
  `pack-check 通过：${paths.length} 个文件 / ${(report.size / 1024).toFixed(1)} kB\n` +
    paths.map((path) => `  ${path}`).join('\n') +
    '\n',
);
