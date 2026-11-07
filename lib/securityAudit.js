'use strict';

const MAX_PREVIEW_LENGTH = 240;

const RULES = [
    {
        id: 'filesystem-destructive',
        label: '删除或覆盖文件',
        severity: 'high',
        patterns: [
            /(^|[;&|]\s*|\s)(rm|shred)\s+/i,
            /\bfind\b[^\n;&|]*\s-delete\b/i,
            /\b(remove-item|del|erase|rmdir)\b/i,
            /(^|[;&|]\s*|\s)rd\s+(\/s\b|\/q\b)/i,
            /(^|[^>])>{1,2}\s*\/(dev|etc|boot|sys|proc)\//i
        ]
    },
    {
        id: 'privilege-escalation',
        label: '提升系统权限',
        severity: 'high',
        patterns: [
            /(^|[;&|]\s*|\s)(sudo|doas)\s+/i,
            /(^|[;&|]\s*|\s)su\s+(-|root\b)/i,
            /\brunas\b/i,
            /start-process\b[^\n]*-verb\s+runas\b/i
        ]
    },
    {
        id: 'power-control',
        label: '关机或重启',
        severity: 'critical',
        patterns: [
            /(^|[;&|]\s*|\s)(shutdown|reboot|poweroff|halt)\b/i,
            /\binit\s+[06]\b/i,
            /\b(restart-computer|stop-computer)\b/i
        ]
    },
    {
        id: 'firewall-network',
        label: '修改防火墙或网络配置',
        severity: 'high',
        patterns: [
            /(^|[;&|]\s*|\s)(iptables|ip6tables|nft|ufw|firewall-cmd)\b/i,
            /\bnetsh\s+(advfirewall|interface)\b/i,
            /(^|[;&|]\s*|\s)ip\s+(link|addr|route)\s+(add|del|delete|set|flush|replace)\b/i
        ]
    },
    {
        id: 'service-control',
        label: '修改系统服务',
        severity: 'high',
        patterns: [
            /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask)\b/i,
            /(^|[;&|]\s*|\s)service\s+\S+\s+(start|stop|restart|reload)\b/i,
            /\bsc(?:\.exe)?\s+(create|delete|start|stop|config|failure)\b/i,
            /\b(start-service|stop-service|restart-service|set-service|new-service)\b/i
        ]
    },
    {
        id: 'git-destructive',
        label: '破坏性 Git 操作',
        severity: 'high',
        patterns: [
            /\bgit\s+push\b[^\n;&|]*(--force(?:-with-lease)?|-f\b)/i,
            /\bgit\s+reset\b[^\n;&|]*--hard\b/i,
            /\bgit\s+clean\b[^\n;&|]*-[^\s]*f/i,
            /\bgit\s+branch\b[^\n;&|]*-D\b/,
            /\bgit\s+(checkout|restore)\b[^\n;&|]*\s--\s/i
        ]
    },
    {
        id: 'database-destructive',
        label: '删除数据库数据或结构',
        severity: 'critical',
        patterns: [
            /\bdrop\s+(database|schema|table|view|index)\b/i,
            /\btruncate\s+(table\s+)?[\w"`\[]/i,
            /\bdelete\s+from\s+[\w"`\[]+(?![\s\S]*\bwhere\b)/i,
            /\b(redis-cli\s+)?flush(all|db)\b/i
        ]
    },
    {
        id: 'package-removal',
        label: '卸载软件包',
        severity: 'high',
        patterns: [
            /\b(apt|apt-get)\s+(remove|purge|autoremove)\b/i,
            /\b(dnf|yum|zypper)\s+(remove|erase)\b/i,
            /\b(pacman\s+-R|apk\s+del)\b/i,
            /\b(pip3?|npm|pnpm|yarn|gem|cargo)\s+(uninstall|remove)\b/i,
            /\b(choco|winget)\s+uninstall\b/i,
            /\buninstall-package\b/i
        ]
    },
    {
        id: 'process-termination',
        label: '终止进程',
        severity: 'high',
        patterns: [
            /(^|[;&|]\s*|\s)(kill|killall|pkill)\s+/i,
            /\btaskkill\b/i,
            /\bstop-process\b/i
        ]
    },
    {
        id: 'pipe-to-shell',
        label: '下载内容后直接执行',
        severity: 'critical',
        patterns: [
            /\b(curl|wget|fetch|irm|invoke-webrequest)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|fish|pwsh|powershell|cmd)(?:\.exe)?\b/i,
            /\binvoke-expression\b|\biex\s*\(/i
        ]
    },
    {
        id: 'encoded-powershell',
        label: '执行编码 PowerShell',
        severity: 'critical',
        patterns: [
            /\b(powershell|pwsh)(?:\.exe)?\b[^\n]*(?:-e(?:nc(?:odedcommand)?)?\b|frombase64string\s*\()/i
        ]
    },
    {
        id: 'disk-partition',
        label: '修改磁盘或分区',
        severity: 'critical',
        patterns: [
            /(^|[;&|]\s*|\s)(mkfs(?:\.\w+)?|fdisk|sfdisk|cfdisk|parted|diskpart)\b/i,
            /\bdd\b[^\n;&|]*\bof=\s*\/dev\//i,
            /(^|[;&|]\s*|\s)(wipefs|blkdiscard)\b/i,
            /(^|[;&|]\s*|\s)format(?:\.com)?\s+[A-Za-z]:/i,
            /\b(clear-disk|initialize-disk|remove-partition|new-partition)\b/i
        ]
    },
    {
        id: 'permission-ownership',
        label: '修改权限或所有者',
        severity: 'high',
        patterns: [
            /(^|[;&|]\s*|\s)(chmod|chown|chgrp|setfacl)\s+/i,
            /\b(icacls|takeown)\b/i
        ]
    },
    {
        id: 'system-configuration',
        label: '修改系统配置',
        severity: 'high',
        patterns: [
            /\b(reg\s+(add|delete|import|restore)|new-itemproperty|set-itemproperty|remove-itemproperty)\b/i,
            /\b(crontab\s+-[er]|schtasks\s+\/(create|delete|change|run|end))\b/i,
            /\b(sysctl\s+-w|set-executionpolicy)\b/i
        ]
    },
    {
        id: 'orchestrator-destructive',
        label: '删除运行环境资源',
        severity: 'high',
        patterns: [
            /\b(kubectl|oc)\s+(delete|drain)\b/i,
            /\bdocker\s+(system|volume|image|container)\s+prune\b/i,
            /\bterraform\s+destroy\b/i
        ]
    }
];

function normalizeCommand(command) {
    return String(command == null ? '' : command)
        .replace(/\0/g, '')
        .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
        .trim();
}

function auditCommand(command, options = {}) {
    const normalized = normalizeCommand(command);
    const matches = [];
    for (const rule of RULES) {
        if (rule.patterns.some((pattern) => pattern.test(normalized))) {
            matches.push({ id: rule.id, label: rule.label, severity: rule.severity });
        }
    }

    if (options.requiresConfirmation === true) {
        matches.push({ id: 'model-requested-confirmation', label: 'AI 明确要求确认', severity: 'high' });
    }

    const uniqueMatches = Array.from(new Map(matches.map((match) => [match.id, match])).values());
    const critical = uniqueMatches.some((match) => match.severity === 'critical');
    return {
        risk: critical ? 'critical' : (uniqueMatches.length ? 'high' : 'low'),
        requiresConfirmation: uniqueMatches.length > 0,
        matches: uniqueMatches,
        matchedPatterns: uniqueMatches.map((match) => match.label),
        commandPreview: normalized.length > MAX_PREVIEW_LENGTH
            ? normalized.slice(0, MAX_PREVIEW_LENGTH) + '...'
            : normalized
    };
}

module.exports = {
    RULES,
    auditCommand,
    normalizeCommand
};
