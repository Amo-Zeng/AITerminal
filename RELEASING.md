# 构建与发布 / Building and releasing

公开源码仓库为 [Amo-Zeng/AITerminal](https://github.com/Amo-Zeng/AITerminal)，主分支为 `main`。普通贡献者只需 Fork、开发和提交 PR，无需维护者凭据。

## 普通 push 的三平台构建

`.github/workflows/windows-build.yml` 是沿用的文件名，实际始终包含 Windows x64、Linux x64 和 macOS arm64 三个平台。普通 push 到 `main`、`release/**`，或推送 `v*` 标签会自动构建；PR 和手动触发也可运行。Fork 中需先启用 Actions。

构建使用 Node.js 22 与 `npm ci`，运行单测、凭据扫描、依赖审计、真实 Electron/PTY/插件/Webhook 冒烟、打包源码一致性与打包后启动。Windows 不带用户的 WSL Ubuntu 发行版；默认参数由门禁检查，安装后的 WSL 交互仍需在具备 Ubuntu 的 Windows 上验收。macOS 当前无签名/公证，架构为 arm64。

每个平台上传一个带源码提交 SHA 的 artifact，包含安装包、`SHA256SUMS.txt` 和 `sbom.cdx.json`，保留 14 天。CI 无需模型 Key、SSH 凭据或真实 Webhook。PR 工作流只持有只读仓库权限，不向第三方贡献暴露发布秘密。

## 构建后自动同步下载页

维护者正常更新版本、提交并 `git push`，三平台成功后工作流会自动执行 `Publish verified installers`。该阶段使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需另存个人 Key。只有 `Amo-Zeng/AITerminal` 的非 PR 构建可以发布；PR、Fork 和私有打包库仍只构建，发布阶段之外的任务保持只读仓库权限。

1. `package.json` 与 lockfile 使用相同版本，CHANGELOG 记录本次变化；新功能发布前更新版本，并保留原 Logo 与许可证。
2. 三个平台全部通过后，从**当前工作流、同一提交**下载 artifact。验证三个安装包名称/版本、SHA-256 与各平台 SBOM 身份，缺少任一平台就停止发布。
3. 创建 Release 草稿，上传安装包、各平台 SBOM、合并的 `SHA256SUMS.txt` 和 `release-provenance.json`。再次核对 GitHub 上每个附件的大小、摘要与上传状态。
4. 全部上传完成才公开 Release 并更新 `/releases/latest`。任一上传失败会保留草稿，旧下载继续可用；在 Actions 重跑失败的发布任务即可续传。
5. 已发布附件与标签不覆盖。版本第一次发布使用 `v<version>`；普通构建若沿用已发布版本，会创建 `v<version>-build.<run_number>` 并显示构建号，避免新构建无法同步下载。正式版本更新仍应递增 package 版本。推送显式 `v*` 标签时必须与 package 版本和源码一致。

发布任务串行运行，并比较新旧源码的祖先关系：较旧或分叉的源码构建可保留独立下载，但不能把 Latest 倒退。正式发布记录包含源码 SHA 和 Actions 链接，`release-provenance.json` 记录安装包摘要。同一任务重跑会验证已有附件，不重复发布。

在目标系统进行适用的人工安装/交互验证并记录范围；Windows 需验证 WSL Ubuntu，macOS 说明未签名状态。维护发布脚本时运行 `node --test test/publishRelease.test.js`，覆盖三平台完整性、摘要失败、上传中断续传、幂等重跑和旧构建不覆盖新下载。

## 原有私有打包脚本

维护者可继续使用原有 `Amo-Zeng/AITerminal-build` 私有构建库和一键脚本；它不是开源贡献的前置条件，也不会自动同步到公开主分支。

```bash
# 先在当前 shell 安全设置 AITERMINAL_GITHUB_TOKEN、GITHUB_TOKEN 或 GH_TOKEN
npm run publish:github-build
# Fork 作者若需要此可选脚本，必须显式指定自己的目标仓库：
npm run publish:github-build -- --repo YOUR_ACCOUNT/YOUR_REPO
```

默认创建新的 `release/*` 分支，运行检查、推送、等待三平台并将产物下载到 `release/github-actions/`。可选参数为 `--no-wait`、`--no-download`、`--dry-run`。Token 仅从环境读取；Fine-grained token 需要目标仓库 `Contents: Read and write`、`Actions: Read`，推送 workflow 文件还需要相应 workflow 写权限。不要在 Git URL、脚本、命令历史或公开日志中记录 Token。

脚本不拉取或覆盖远端旧源码，不因私有仓库不可访问而改推公开仓库。网络代理失败时会尝试直连，`AITERMINAL_GITHUB_DIRECT=1` 可指定直连。私有库的历史提交不会自动成为公开源码历史；仅向公开仓库推送已审核的源码。

## English summary

The public workflow builds Windows, Linux and macOS on ordinary pushes and PRs without maintainer secrets. The legacy filename `windows-build.yml` covers all three platforms. In the main repository, successful non-PR builds automatically stage, verify and publish a GitHub Release using the built-in workflow token. All three builds must succeed; incomplete uploads remain drafts. Published tags/assets are immutable, repeated builds of the same package version get a build suffix, and older source builds cannot replace a newer Latest download. Actions artifacts expire after 14 days; Releases provide durable downloads.

Fork contributors do not need the private build repository. The optional `publish:github-build` helper defaults to the maintainer's private repository; pass `--repo YOUR_ACCOUNT/YOUR_REPO` for your own repository. Keep tokens in environment variables, never in remote URLs or files. See the [contribution guide](CONTRIBUTING.md) for development checks.
