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
- 发布完成后核对 `/releases/latest`、版本标签源码和公开附件摘要，再记录最终 CI 链接。
