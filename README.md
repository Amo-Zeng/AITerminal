# AITerminal 🚀

<div align="center">

![AITerminal Logo](./logo.svg)

**AI 驱动的智能终端 - 让命令行操作更简单、更智能！**

[![Windows](https://img.shields.io/badge/Platform-Windows-blue.svg)](https://github.com/Amo-Zeng/AITerminal/releases)
[![Linux](https://img.shields.io/badge/Platform-Linux-orange.svg)](https://github.com/Amo-Zeng/AITerminal/releases)
[![macOS](https://img.shields.io/badge/Platform-macOS-lightgrey.svg)](https://github.com/Amo-Zeng/AITerminal/releases) 
[![Version](https://img.shields.io/badge/Version-1.0.0-green.svg)](https://github.com/Amo-Zeng/AITerminal/releases)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/Amo-Zeng/AITerminal/total.svg)](https://github.com/Amo-Zeng/AITerminal/releases)

</div>

## 📖 项目简介

AITerminal 是一款革命性的多平台（windows, linux, mac）智能终端助手，它将强大的 SSH 客户端与先进的 AI 助手功能无缝集成。通过直观的界面和自然语言处理能力，AITerminal 旨在提升您的工作效率，简化复杂的命令行操作，并提供前所未有的交互体验。

### ✨ 核心特性

- 🤖 **AI 驱动**: 内置强大的 AI 助手，支持智能问答、错误诊断、自然语言转命令等。
- 🔗 **SSH 客户端**: 提供稳定高效的 SSH 连接，支持文件传输、远程文件管理。
- 🗣️ **自然交互**: 支持中文自然语言命令输入，降低命令行使用门槛。
- ⚡ **智能转换**: AI 自动将自然语言转换为系统命令，并可直接执行。
- 🎨 **现代界面**: 简洁美观的用户界面设计，支持多种主题和字体定制。
- 🛡️ **安全可靠**: 内置安全检查机制，保障操作安全。
- 📚 **学习能力**: 持续优化 AI 模型，提供更准确、个性化的建议。

## 🎯 主要功能

<table>
<tr>
<td width="25%">

### 🤖 AI 智能助手
- 智能问答与建议
- 错误诊断与修复
- 自然语言转命令
- 系统分析与优化

</td>
<td width="25%">
   
### 🔗 SSH 客户端
- 直观的连接管理
- 文件拖拽上传
- 可设置常用命令
- 直接发送命令至远程
- 远程文件浏览 (`rfe`)
- 远程文件点击打开 (`myls`)

</td>
<td width="25%">

### ⚙️ 高度可定制
- 终端主题与字体
- AI 模型与 API 配置
- AI提示词定制
- 光标样式与滚动行数
- 自动登录与执行命令

</td>
<td width="25%">
   
### 🚀 效率工具
- 快捷键支持
- 会话保存与加载
- 流式 AI 回复
- AI 回复分屏显示

</td>
</tr>
</table>

## 💡 使用示例

### AI 智能问答与建议

直接向 AI 提问，获取技术解答、操作建议或代码片段。

```
用户输入: "如何查看Linux系统内存使用情况？"(下图这一句输太快了，没录上)
AI回复: "您可以使用 `free -h` 命令来查看 Linux 系统的内存使用情况。..."
```
![AI Chat](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/ai-chat.gif?raw=true)

### 自然语言转命令

将您的需求用自然语言描述，AI 会自动生成相应的 Linux 命令，并可直接执行。

```
用户输入: "cmd 查找所有大于100MB的文件"
AI转换: find . -type f -size +100M
执行结果: [大文件列表]
```
![AI Cmd](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/ai-cmd.gif?raw=true)

### 文件拖拽上传

直接将本地文件拖拽到终端窗口，即可快速上传到远程服务器。

![Drag and Drop Upload](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/drag-upload.gif?raw=true)

### 远程文件浏览与下载

通过 `rfe` 命令直观地浏览远程文件系统，点击即可下载文件或进入目录。

![Remote File Explorer](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/rfe.gif?raw=true)


通过 `myls` 命令直观地列出远程文件系统，点击即可下载并打开文件,可以一键看服务器上的图片。

![Remote File Explorer](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/myls.gif?raw=true)

## 🖼️ 软件截图

### 主界面与 SSH 连接
AITerminal 的主界面简洁直观，SSH 连接配置一目了然。
![主界面](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/ssh-connect.gif?raw=true)

### AI 回复分屏显示
AI 回复支持实时流式输出，并在独立的分屏区域显示，支持 Markdown、代码高亮和数学公式渲染（看起来公式渲染改坏了，待修）。
![AI Streaming](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/ai-streaming.gif?raw=true)

### 终端主题定制
多种内置终端主题，满足您的个性化需求。
![终端主题](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/terminal-themes.gif?raw=true)

## 🚀 快速开始

### 安装步骤

## windows系统

1. **下载安装包**
   [点击下载安装包](https://github.com/Amo-Zeng/AITerminal/releases/download/v1.1.0/AITerminal.Setup.1.1.0.exe)

2. **运行安装程序**
   - 双击 `AITerminal.Setup.1.0.0.exe`
   - 按照安装向导完成安装

3. **启动应用**
   - 从开始菜单或桌面快捷方式启动 AITerminal
   - 首次运行建议进行 SSH 和 AI 配置
     
## linux系统
1. **下载安装包**
   [点击下载安装包](https://github.com/Amo-Zeng/AITerminal/releases/download/v1.1.0/AITerminal-1.1.0.AppImage)

2. **双击运行程序**
   - 双击 `AITerminal-1.1.0.AppImage`打开软件，直接使用
     
## mac系统
   -  [点击下载安装包](https://github.com/Amo-Zeng/AITerminal/releases/download/v1.1.0/AITerminal-1.1.0-arm64.dmg)
   -  sudo xattr -r -d com.apple.quarantine /Applications/AITerminal.app  (根据佬友反馈：mac 安装需要执行这个命令。显示已损坏是正常的，用以上命令或拖到Sentinel里？)

## 📋 更新日志
### v1.1.0 (2025.7.8)

#### 🐞 Bug 修复
- 修复 Mac 下无法复制粘贴的问题
- 修复模型名选择和输入框之间的 bug
- `api_url` 兼容 `https://api.openai.com` 和 `https://api.openai.com/v1/chat/completions`
- 修复未登录 SSH 无法更改其它配置的问题
- 暗黑模式下边框未变暗的问题已修复
- 支持公式渲染

#### 🚀 新增&增强功能
- 支持密钥登录 SSH
- 可设置常用 bash 命令，输入 `/` 快捷调出并一键发送
- 支持显示完整的多轮对话历史
- AI 回答可附加自定义要求（如“请简短回答”等）
- 增加send命令，用于向远程发送bash命令（如send ls）
---
### v1.0.0 (2025-07-03)
- 🎉 首次发布
- ✅ 基础 AI 命令转换功能
- ✅ 强大的 SSH 连接管理
- ✅ 文件拖拽上传与远程文件浏览
- ✅ 现代化用户界面与主题定制
- ✅ 安全检查机制
- ✅ 中文自然语言支持

## 🔮 未来规划

- 🌟 **开源计划**: 项目壮大后将逐步开源
- 🔧 **功能扩展**: 支持更多系统操作和工具，如 SFTP 客户端、端口转发等。
- 🌍 **多语言支持**: 增加英语等其他语言支持。
- 📱 **跨平台**: 计划支持 macOS 和 Linux。
- 🤖 **AI增强**: 持续优化 AI 模型，提高识别准确率和回复质量。
- 🔌 **插件系统**: 支持第三方插件扩展，丰富功能生态。

## 🤝 反馈与支持

我们非常重视用户的反馈和建议！

### 📞 联系方式
- **Issues**: [GitHub Issues](https://github.com/Amo-Zeng/AITerminal/issues)
- **Email**: 1019191262@qq.com
- **QQ群**: 1053768305

### 🐛 问题报告
如果您遇到任何问题，请通过以下方式报告：
1. 详细描述问题现象
2. 提供操作步骤
3. 附上错误截图（如有）
4. 说明系统环境信息

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🙏 致谢

感谢所有为这个项目提供建议和支持的用户们！

---

<div align="center">

**如果这个项目对您有帮助，请给我们一个 ⭐ Star！**

[下载最新版本](https://github.com/Amo-Zeng/AITerminal/releases) | [报告问题](https://github.com/Amo-Zeng/AITerminal/issues) | [功能建议](https://github.com/Amo-Zeng/AITerminal/issues)

</div>
