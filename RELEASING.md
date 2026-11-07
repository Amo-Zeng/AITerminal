# 构建与发布 / Building and releasing

公开源码仓库为 [Amo-Zeng/AITerminal](https://github.com/Amo-Zeng/AITerminal)，主分支为 `main`。普通贡献者只需 Fork、开发和提交 PR，无需维护者凭据。

## 普通 push 的三平台构建

`.github/workflows/windows-build.yml` 是沿用的文件名，实际始终包含 Windows x64、Linux x64 和 macOS arm64 三个平台。普通 push 到 `main`、`release/**`，或推送 `v*` 标签会自动构建；PR 和手动触发也可运行。Fork 中需先启用 Actions。

构建使用 Node.js 22 与 `npm ci`，运行单测、凭据扫描、依赖审计、真实 Electron/PTY/插件/Webhook 冒烟、打包源码一致性与打包后启动。Windows 不带用户的 WSL Ubuntu 发行版；默认参数由门禁检查，安装后的 WSL 交互仍需在具备 Ubuntu 的 Windows 上验收。macOS 当前无签名/公证，架构为 arm64。

每个平台上传一个带源码提交 SHA 的 artifact，包含安装包、`SHA256SUMS.txt` 和 `sbom.cdx.json`，保留 14 天。CI 无需模型 Key、SSH 凭据或真实 Webhook。PR 工作流只持有只读仓库权限，不向第三方贡献暴露发布秘密。

## 维护者发布正式版本

1. 更新 `package.json`、lockfile 根版本、CHANGELOG 和受影响的兼容性文档；保留原 Logo 与许可证。
2. 推送源码，等待同一提交的三平台检查全部通过。不要将一个平台成功当成全部成功。
3. 获取该提交的三个 artifact，验证 GitHub artifact 摘要及包内 SHA-256；保留各平台 SBOM。检查安装包版本和架构。
4. 在目标系统进行适用的人工安装/交互验证，说明未验证范围；Windows 特别关注 WSL Ubuntu，macOS 说明未签名状态。
5. 将版本标签指向已验证的源码提交，创建 GitHub Release，上传安装包、合并后的校验和与各平台 SBOM，写明源码和 Actions 链接。不要用未经验证的旧包替代。

当前 workflow 只构建和上传 Actions artifact，**不会自动创建 Release**，避免 PR 或普通 push 意外发布正式版本。

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

The public workflow builds Windows, Linux and macOS on ordinary pushes and PRs without maintainer secrets. The legacy filename `windows-build.yml` covers all three platforms. Actions artifacts expire after 14 days; durable releases are published by maintainers only after all platform checks pass and artifacts match the verified source commit.

Fork contributors do not need the private build repository. The optional `publish:github-build` helper defaults to the maintainer's private repository; pass `--repo YOUR_ACCOUNT/YOUR_REPO` for your own repository. Keep tokens in environment variables, never in remote URLs or files. See the [contribution guide](CONTRIBUTING.md) for development checks.
