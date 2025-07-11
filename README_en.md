# AITerminal 🚀

<div align="center">

![AITerminal Logo](./logo.svg)

**AI-powered intelligent terminal - making command line operations simpler and smarter!**

[![Windows](https://img.shields.io/badge/Platform-Windows-blue.svg)](https://github.com/Amo-Zeng/AITerminal/releases)
[![Linux](https://img.shields.io/badge/Platform-Linux-orange.svg)](https://github.com/Amo-Zeng/AITerminal/releases)
[![macOS](https://img.shields.io/badge/Platform-macOS-lightgrey.svg)](https://github.com/Amo-Zeng/AITerminal/releases) 
[![Version](https://img.shields.io/badge/Version-1.0.0-green.svg)](https://github.com/Amo-Zeng/AITerminal/releases)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/Amo-Zeng/AITerminal/total.svg)](https://github.com/Amo-Zeng/AITerminal/releases)

</div>

## 📖 Project Introduction

AITerminal is a revolutionary cross-platform (Windows, Linux, macOS) intelligent terminal assistant that seamlessly integrates a powerful SSH client with advanced AI assistant features. Through an intuitive interface and natural language interaction, it makes terminal operations easier and smarter.

### ✨ Core Features

- 🤖 **AI-powered**: Built-in powerful AI assistant supporting smart Q&A, error diagnosis, natural language to command conversion, and more.
- 🤖 **AI Takeover Mode**: AI can autonomously develop software based on user needs.
- 🔗 **SSH Client**: Provides stable and efficient SSH connections, supports file transfer and remote file management.
- 🗣️ **Natural Interaction**: Supports Chinese natural language command input, lowering the barrier to command line usage.
- ⚡ **Smart Conversion**: AI automatically converts natural language into system commands for direct execution.
- 🎨 **Modern Interface**: Simple and beautiful UI design, supports various themes and font customization.
- 🛡️ **Secure and Reliable**: Built-in security check mechanism to ensure operational safety.
- 📚 **Learning Ability**: Continuously optimizes AI models to provide more accurate and personalized suggestions.

## 🎯 Main Functions

<table>
<tr>
<td width="25%">

### 🤖 AI Assistant
- Smart Q&A and suggestions
- Error diagnosis and repair
- Natural language to command
- System analysis and optimization

</td>
<td width="25%">
   
### 🔗 SSH Client
- Intuitive connection management
- Drag-and-drop file upload
- Customizable common commands
- Direct command sending to remote server
- Remote file browsing (`rfe`)
- Click to open remote files (`myls`)

</td>
<td width="25%">

### ⚙️ Highly Customizable
- Terminal themes and fonts
- AI model and API configuration
- Custom AI prompts
- Cursor style and scroll lines
- Auto login and command execution

</td>
<td width="25%">
   
### 🚀 Productivity Tools
- Hotkey support
- Session save and load
- Streaming AI replies
- Split-screen display for AI replies

</td>
</tr>
</table>

## 💡 Usage Examples

### AI Q&A and Suggestions

Ask the AI directly for technical solutions, operational suggestions, or code snippets.

```
User input: "How to check memory usage on Linux?"
AI reply: "You can use the `free -h` command to check memory usage on Linux..."
```
![AI Chat](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/ai-chat.gif?raw=true)

### Natural Language to Command

Describe your needs in natural language, and AI will generate the corresponding Linux command for direct execution.

```
User input: "cmd to find all files larger than 100MB"
AI conversion: find . -type f -size +100M
Execution result: [List of large files]
```
![AI Cmd](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/ai-cmd.gif?raw=true)

### Drag-and-drop File Upload

Drag local files to the terminal window to quickly upload them to the remote server.

![Drag and Drop Upload](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/drag-upload.gif?raw=true)

### Remote File Browsing and Download

Browse remote file systems visually with the `rfe` command, click to download or enter directories.

![Remote File Explorer](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/rfe.gif?raw=true)

List remote files with the `myls` command, click to download and open files, view images on the server with one click.

![Remote File Explorer](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/myls.gif?raw=true)

## 🖼️ Software Screenshots

### Main Interface & SSH Connection
AITerminal’s main interface is simple and intuitive, with clear SSH connection configuration.

![Main Interface](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/ssh-connect.gif?raw=true)

### Split-screen AI Replies
AI replies support real-time streaming output and are displayed in a separate split-screen area, supporting Markdown, code highlighting, and math formula rendering (formula rendering needs fixing).

![AI Streaming](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/ai-streaming.gif?raw=true)

### Terminal Theme Customization
Multiple built-in terminal themes to meet your personalized needs.

![Terminal Themes](https://github.com/Amo-Zeng/AITerminal/blob/main/assets/terminal-themes.gif?raw=true)

## 🚀 Quick Start

### Installation Steps

#### Windows

1. **Download Installer**
   [Download Installer](https://github.com/Amo-Zeng/AITerminal/releases/download/v1.2.0/AITerminal.Setup.1.1.0.exe)

2. **Run Installer**
   - Double-click `AITerminal.Setup.1.0.0.exe`
   - Complete installation via the setup wizard

3. **Start the App**
   - Launch AITerminal from the Start Menu or desktop shortcut
   - It’s recommended to configure SSH and AI on first run

#### Linux

1. **Download Installer**
   [Download Installer](https://github.com/Amo-Zeng/AITerminal/releases/download/v1.2.0/AITerminal-1.1.0.AppImage)

2. **Run the App**
   - Double-click `AITerminal-1.1.0.AppImage` to open and use directly

#### macOS

- [Download Installer](https://github.com/Amo-Zeng/AITerminal/releases/download/v1.2.0/AITerminal-1.1.0-arm64.dmg)
- sudo xattr -r -d com.apple.quarantine /Applications/AITerminal.app  (If it shows as damaged, this is normal; as per feedback, you need to run this command.)

## 📋 Changelog

#### v1.2.0 (2025.7.12)

- **New: AI takeover mode (similar to gemini-cli)**  
  Allows AI to freely execute Bash commands in the current and subdirectories, enabling automated development. The AI can make plans and carry them out step by step.

- **Settings pagination**  
  Settings page now supports pagination for easier navigation and management.

- **Multi-tab support**  
  Multiple tabs can be opened in the same window for improved multitasking.

#### v1.1.0 (2025.7.8)

##### 🐞 Bug Fixes
- Fixed copy-paste issue on Mac
- Fixed bug between model selection and input box
- `api_url` now supports both `https://api.openai.com` and `https://api.openai.com/v1/chat/completions`
- Fixed issue where SSH login was required to change other settings
- Dark mode border color issue fixed
- Formula rendering supported

##### 🚀 New & Enhanced Features
- SSH key login supported
- Custom Bash commands can be set; type `/` to quickly call and send
- Full multi-turn conversation history display
- AI answers can include custom requirements (e.g., “please answer briefly”)
- Added `send` command to send bash commands to remote (e.g., send ls)

---

#### v1.0.0 (2025-07-03)
- 🎉 Initial release
- ✅ Basic AI command conversion feature
- ✅ Powerful SSH connection management
- ✅ Drag-and-drop upload and remote file browsing
- ✅ Modern UI and theme customization
- ✅ Security check mechanism
- ✅ Chinese natural language support

## 🔮 Future Plans

- 🌟 **Open source plan**: Will gradually open source as the project grows
- 🔧 **Feature extension**: Support for more system operations and tools (e.g., SFTP client, port forwarding)
- 🌍 **Multi-language support**: Add support for English and other languages
- 📱 **Cross-platform**: Plan to support macOS and Linux
- 🤖 **AI enhancement**: Continuously optimize AI models for better accuracy and quality
- 🔌 **Plugin system**: Support for third-party plugins to enrich the ecosystem

## 🤝 Feedback & Support

We highly value your feedback and suggestions!

### 📞 Contact
- **Issues**: [GitHub Issues](https://github.com/Amo-Zeng/AITerminal/issues)
- **Email**: 1019191262@qq.com
- **QQ Group**: 1053768305

### 🐛 Bug Report
If you encounter any issues, please report by:
1. Describing the problem in detail
2. Providing steps to reproduce
3. Attaching error screenshots (if any)
4. Specifying system environment details

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Thanks

Thank you to all users who have provided suggestions and support for this project!

---

<div align="center">

**If you find this project helpful, please give us a ⭐ Star!**

[Download latest version](https://github.com/Amo-Zeng/AITerminal/releases) | [Report Issues](https://github.com/Amo-Zeng/AITerminal/issues) | [Feature Suggestions](https://github.com/Amo-Zeng/AITerminal/issues)

</div>
