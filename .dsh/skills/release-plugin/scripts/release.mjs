#!/usr/bin/env node

/**
 * release.mjs
 * 自动化发版辅助脚本：更新版本号、归档更新日志、门禁检查、构建、Git Commit & Tag
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../');

function run(command, options = {}) {
  console.log(`\n\x1b[36m> ${command}\x1b[0m`);
  return execSync(command, { cwd: projectRoot, stdio: 'inherit', ...options });
}

function runCapture(command) {
  return execSync(command, { cwd: projectRoot, encoding: 'utf8' }).trim();
}

async function main() {
  const pkgPath = path.join(projectRoot, 'package.json');
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');

  if (!fs.existsSync(pkgPath)) {
    console.error('Error: package.json not found in project root.');
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const currentVersion = pkg.version;
  console.log(`\x1b[32m当前版本: ${currentVersion}\x1b[0m`);

  let targetVersion = process.argv[2];

  if (!targetVersion) {
    console.log(`请指定目标版本号，例如: node release.mjs 0.13.2`);
    console.log(`或者在 package.json 已经更新版本的情况下，传入当前版本: node release.mjs ${currentVersion}`);
    process.exit(1);
  }

  targetVersion = targetVersion.replace(/^v/, '');
  console.log(`\x1b[32m目标版本: ${targetVersion}\x1b[0m`);

  // 1. 更新 package.json
  if (pkg.version !== targetVersion) {
    pkg.version = targetVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log(`[1/5] package.json 版本号已更新为: ${targetVersion}`);
  } else {
    console.log(`[1/5] package.json 版本号已是: ${targetVersion}`);
  }

  // 2. 更新 CHANGELOG.md (归档 Unreleased)
  if (fs.existsSync(changelogPath)) {
    let changelog = fs.readFileSync(changelogPath, 'utf8');
    const today = new Date().toISOString().split('T')[0];
    const unreleasedHeaderRegex = /(# Changelog\s*\r?\n\r?\n)## Unreleased\s*(\r?\n)/i;

    if (unreleasedHeaderRegex.test(changelog) && !changelog.includes(`## ${targetVersion}`)) {
      changelog = changelog.replace(
        unreleasedHeaderRegex,
        `$1## Unreleased\n\n## ${targetVersion} - ${today}$2`
      );
      fs.writeFileSync(changelogPath, changelog, 'utf8');
      console.log(`[2/5] CHANGELOG.md 已将未发布改动归档至 ## ${targetVersion} - ${today}`);
    } else {
      console.log(`[2/5] CHANGELOG.md 已包含版本 ${targetVersion} 或未找到 Unreleased 占位`);
    }
  }

  // 3. 执行门禁检查
  console.log('\n[3/5] 执行全量类型检查与单元测试...');
  run('npm run typecheck');
  run('npm test');

  // 4. 清理旧产物并构建
  console.log('\n[4/5] 清理 lib 并重新纯净构建...');
  const libDir = path.join(projectRoot, 'lib');
  if (fs.existsSync(libDir)) {
    fs.rmSync(libDir, { recursive: true, force: true });
  }
  run('npm run build');
  run('npm pack --dry-run');

  // 5. Git Commit & Tag
  console.log('\n[5/5] Git 提交与打 Tag...');
  run('git add package.json CHANGELOG.md');

  const status = runCapture('git status --porcelain package.json CHANGELOG.md');
  if (status) {
    run(`git commit -m "chore(release): bump package version to ${targetVersion}"`);
  } else {
    console.log('package.json 与 CHANGELOG.md 无新变更需 commit。');
  }

  const tagName = `v${targetVersion}`;
  const existingTags = runCapture('git tag -l').split(/\r?\n/);
  if (existingTags.includes(tagName)) {
    console.log(`Tag ${tagName} 已存在，跳过打 tag。`);
  } else {
    run(`git tag ${tagName}`);
    console.log(`\x1b[32mGit Tag ${tagName} 创建成功！\x1b[0m`);
  }

  console.log('\n\x1b[32m========================================================\x1b[0m');
  console.log(`\x1b[32m发版准备就绪！请运行以下命令推送到 GitHub 触发云端自动发版：\x1b[0m`);
  console.log(`\x1b[33mgit push origin master --tags\x1b[0m`);
  console.log('\x1b[32m========================================================\x1b[0m\n');
}

main().catch((err) => {
  console.error('\n\x1b[31m发版流程失败:\x1b[0m', err.message);
  process.exit(1);
});
