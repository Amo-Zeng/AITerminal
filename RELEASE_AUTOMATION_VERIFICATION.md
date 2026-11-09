# Releases 自动同步验证

日期：2026-11-07。目标：每次主仓库构建完三平台安装包后，自动把通过验证的安装包同步到正式下载页，避免 Actions 已有新包而 Releases 仍展示旧版。

## 根因与修复

原工作流止于上传 Actions artifact，需要维护者手动创建 Release。新增 `publish` job 依赖三平台 `build` 全部成功，使用 GitHub 工作流内置令牌，无需用户另配 API Key。PR 和 Fork 不进入发布阶段。

`scripts/publishRelease.js` 校验当前工作流、源码 SHA、三个成功的构建任务、安装包版本/文件摘要和 SBOM；随后在 Release 草稿中上传三平台安装包、三份 SBOM、合并校验和与源码记录。只有 GitHub 返回的附件数量、大小、SHA-256 和状态全部匹配，才公开 Release 并更新 Latest。发布中断保留草稿并支持重跑；已发布附件和标签不替换，旧源码也不能把最新下载倒退。

本次 package 与 lockfile 升级到 **1.6.0**，CHANGELOG 和中英文 README 同步。后续普通 `git push` 不需要再手工搬运 Actions 附件；具体命名和恢复方法见 [RELEASING.md](RELEASING.md)。

## 验证

- `node --test test/publishRelease.test.js`：6 项通过，覆盖三平台完整性、摘要损坏、构建失败、先上传后公开、重复执行、上传中断续传和旧构建不覆盖新下载。
- `npm test`：171 项，170 通过、1 项按平台跳过、0 失败。
- 工作流 YAML 可解析；`publish` 明确依赖 `build`，写权限只授予发布 job。
- `npm run security:scan` 与 `git diff --check` 通过；模型、SSH、Webhook 等个人凭据不参与发布。

## 正式发布结果

- [三平台构建与自动发布](https://github.com/Amo-Zeng/AITerminal/actions/runs/42361816034)全部成功，包括打包后的应用启动验证；源码为 `c1ac1f2c0828086295139fff7c5ba4271720f64b`。
- [v1.6.0 正式下载](https://github.com/Amo-Zeng/AITerminal/releases/tag/v1.6.0)已公开，[最新下载入口](https://github.com/Amo-Zeng/AITerminal/releases/latest)已匿名确认跳转到该版本。
- 发布时间为 2026-11-07 18:00:51（北京时间）。版本标签和公开的源码记录均指向上述构建源码。
- Windows x64 安装程序、Linux x64 AppImage、macOS arm64 DMG 的公开下载链接均在未登录状态返回 HTTP 200，并指向 GitHub 附件下载服务。
- 发布附件共 8 个：三平台安装包、三份平台 SBOM、`SHA256SUMS.txt` 和 `release-provenance.json`。
- 已匿名下载校验和及源码记录，验证下载内容的 SHA-256；校验和中全部附件摘要与 GitHub 返回的摘要一致。此处验证的是公开下载可达性与完整性，三平台应用启动由上面的原生 CI 任务验证。
