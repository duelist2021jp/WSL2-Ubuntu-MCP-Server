#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const execAsync = promisify(exec);

async function run(cmd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 10000 });
    return stdout.trim();
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return (err.stdout ?? err.stderr ?? err.message ?? String(e)).trim();
  }
}

const server = new McpServer({ name: "mcp-ubuntu-insights", version: "0.2.0" });

// ── 1. system_overview ───────────────────────────────────────────────────────
server.registerTool(
  "get_system_overview",
  {
    description:
      "OS情報・稼働時間・CPU/メモリ/ディスクの概要をまとめて返します。",
    inputSchema: z.object({}),
  },
  async () => {
    const [osRelease, uptime, cpuModel, memInfo, dfOut] = await Promise.all([
      readFile("/etc/os-release", "utf8").catch(() => ""),
      run("uptime -p"),
      run("grep 'model name' /proc/cpuinfo | head -1 | cut -d: -f2"),
      readFile("/proc/meminfo", "utf8").catch(() => ""),
      run("df -h --output=source,size,used,avail,pcent,target -x tmpfs -x devtmpfs"),
    ]);

    const getField = (text: string, key: string) =>
      text.match(new RegExp(`^${key}=(.+)`, "m"))?.[1]?.replace(/"/g, "") ?? "";

    const memLines = memInfo.split("\n");
    const memVal = (key: string) =>
      parseInt(memLines.find((l) => l.startsWith(key))?.split(/\s+/)[1] ?? "0");
    const memTotalKB = memVal("MemTotal:");
    const memAvailKB = memVal("MemAvailable:");
    const memUsedKB = memTotalKB - memAvailKB;

    const result = {
      os: {
        name: getField(osRelease, "PRETTY_NAME"),
        id: getField(osRelease, "ID"),
        version: getField(osRelease, "VERSION_ID"),
      },
      uptime,
      cpu: { model: cpuModel.trim() },
      memory: {
        totalMB: Math.round(memTotalKB / 1024),
        usedMB: Math.round(memUsedKB / 1024),
        availableMB: Math.round(memAvailKB / 1024),
        usedPercent: Math.round((memUsedKB / memTotalKB) * 100),
      },
      disk: dfOut,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── 2. cpu_info ──────────────────────────────────────────────────────────────
server.registerTool(
  "get_cpu_info",
  {
    description: "CPU使用率・コア数・モデル情報を返します。",
    inputSchema: z.object({}),
  },
  async () => {
    const [cpuInfo, loadAvg, mpstat] = await Promise.all([
      readFile("/proc/cpuinfo", "utf8").catch(() => ""),
      readFile("/proc/loadavg", "utf8").catch(() => ""),
      run("mpstat 1 1 2>/dev/null || vmstat 1 2 | tail -1"),
    ]);

    const cores = (cpuInfo.match(/^processor\s*:/gm) ?? []).length;
    const model =
      cpuInfo.match(/^model name\s*:\s*(.+)/m)?.[1]?.trim() ?? "unknown";
    const [la1, la5, la15] = loadAvg.split(" ");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { model, physicalCores: cores, loadAverage: { "1min": la1, "5min": la5, "15min": la15 }, raw: mpstat },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── 3. memory_info ───────────────────────────────────────────────────────────
server.registerTool(
  "get_memory_info",
  {
    description: "メモリ・スワップの使用量を詳しく返します。",
    inputSchema: z.object({}),
  },
  async () => {
    const [memInfo, freeOut] = await Promise.all([
      readFile("/proc/meminfo", "utf8").catch(() => ""),
      run("free -m"),
    ]);
    return {
      content: [{ type: "text", text: JSON.stringify({ procMeminfo: memInfo, free: freeOut }, null, 2) }],
    };
  }
);

// ── 4. disk_info ─────────────────────────────────────────────────────────────
server.registerTool(
  "get_disk_info",
  {
    description: "ディスク使用量・マウントポイント情報を返します。",
    inputSchema: z.object({}),
  },
  async () => {
    const [df, lsblk] = await Promise.all([
      run("df -h"),
      run("lsblk -o NAME,SIZE,TYPE,MOUNTPOINT 2>/dev/null || echo 'lsblk unavailable'"),
    ]);
    return {
      content: [{ type: "text", text: JSON.stringify({ df, lsblk }, null, 2) }],
    };
  }
);

// ── 5. network_info ──────────────────────────────────────────────────────────
server.registerTool(
  "get_network_info",
  {
    description: "ネットワークインターフェース・接続状況・統計情報を返します。",
    inputSchema: z.object({}),
  },
  async () => {
    const [ipAddr, ss, netDev] = await Promise.all([
      run("ip -j addr 2>/dev/null || ip addr"),
      run("ss -tunap 2>/dev/null | head -40"),
      readFile("/proc/net/dev", "utf8").catch(() => ""),
    ]);
    return {
      content: [{ type: "text", text: JSON.stringify({ interfaces: ipAddr, connections: ss, procNetDev: netDev }, null, 2) }],
    };
  }
);

// ── 6. running_services ──────────────────────────────────────────────────────
server.registerTool(
  "get_running_services",
  {
    description: "systemdサービスの稼働状況一覧を返します。",
    inputSchema: z.object({
      state: z
        .enum(["running", "failed", "all"])
        .default("running")
        .describe("取得するサービス状態のフィルター"),
    }),
  },
  async ({ state }) => {
    let cmd = "systemctl list-units --type=service --no-pager --no-legend";
    if (state === "running") cmd += " --state=running";
    else if (state === "failed") cmd += " --state=failed";
    const output = await run(cmd);
    return {
      content: [{ type: "text", text: output || "(該当するサービスなし)" }],
    };
  }
);

// ── 7. top_processes ─────────────────────────────────────────────────────────
server.registerTool(
  "get_top_processes",
  {
    description: "CPUまたはメモリ消費量上位のプロセス一覧を返します。",
    inputSchema: z.object({
      sortBy: z
        .enum(["cpu", "memory"])
        .default("cpu")
        .describe("ソート基準: 'cpu' or 'memory'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(15)
        .describe("返すプロセス数（最大50）"),
    }),
  },
  async ({ sortBy, limit }) => {
    const sortFlag = sortBy === "memory" ? "--sort=-%mem" : "--sort=-%cpu";
    const output = await run(
      `ps aux ${sortFlag} | head -${limit + 1}`
    );
    return {
      content: [{ type: "text", text: output }],
    };
  }
);

// ── 8. security_audit ────────────────────────────────────────────────────────
server.registerTool(
  "get_security_audit",
  {
    description:
      "セキュリティ設定を包括的に診断し、コンプライアンスレポートと改善提案を返します。" +
      "UFW/iptables、SSH設定、sudoers、失敗ログイン試行、自動更新、SUID/SGIDファイル等を確認します。",
    inputSchema: z.object({
      checks: z
        .array(z.enum(["firewall", "ssh", "sudo", "auth_log", "updates", "suid", "all"]))
        .default(["all"])
        .describe("実施するチェック項目（デフォルト: all）"),
    }),
  },
  async ({ checks }) => {
    const runAll = checks.includes("all");

    // ── 各チェックを並列実行 ──
    const [
      ufwStatus, iptablesRules, ip6tablesRules,
      sshdConfig,
      sudoersFiles,
      authLogFail, journalFail,
      unattendedUpgrades, aptAutoconf,
      suidFiles,
      passwdEmpty, shadowDuplicates,
      loginDefs,
      kernelParams,
      listeningPorts,
      worldWritable,
    ] = await Promise.all([
      // firewall
      (runAll || checks.includes("firewall")) ? run("ufw status verbose 2>/dev/null || echo 'ufw: not found'") : Promise.resolve("skipped"),
      (runAll || checks.includes("firewall")) ? run("iptables -L -n --line-numbers 2>/dev/null || echo 'iptables: unavailable'") : Promise.resolve("skipped"),
      (runAll || checks.includes("firewall")) ? run("ip6tables -L -n 2>/dev/null || echo 'ip6tables: unavailable'") : Promise.resolve("skipped"),
      // ssh
      (runAll || checks.includes("ssh")) ? readFile("/etc/ssh/sshd_config", "utf8").catch(() => "sshd_config: not found") : Promise.resolve("skipped"),
      // sudo
      (runAll || checks.includes("sudo")) ? run("cat /etc/sudoers 2>/dev/null; ls /etc/sudoers.d/ 2>/dev/null || echo ''") : Promise.resolve("skipped"),
      // auth_log
      (runAll || checks.includes("auth_log")) ? run("grep -i 'failed\\|failure\\|invalid' /var/log/auth.log 2>/dev/null | tail -20 || echo 'auth.log: not accessible'") : Promise.resolve("skipped"),
      (runAll || checks.includes("auth_log")) ? run("journalctl -u sshd --since '24h ago' -p err..alert --no-pager 2>/dev/null | tail -20 || echo ''") : Promise.resolve("skipped"),
      // updates
      (runAll || checks.includes("updates")) ? run("cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null || echo 'auto-upgrades: not configured'") : Promise.resolve("skipped"),
      (runAll || checks.includes("updates")) ? run("cat /etc/apt/apt.conf.d/50unattended-upgrades 2>/dev/null | head -30 || echo ''") : Promise.resolve("skipped"),
      // suid
      (runAll || checks.includes("suid")) ? run("find / -xdev -perm /6000 -type f 2>/dev/null | sort") : Promise.resolve("skipped"),
      // passwd: empty password
      (runAll || checks.includes("sudo")) ? run("awk -F: '($2==\"\"){print $1}' /etc/passwd 2>/dev/null || echo ''") : Promise.resolve("skipped"),
      // shadow: duplicate uid 0
      (runAll || checks.includes("sudo")) ? run("awk -F: '($3==0){print $1}' /etc/passwd 2>/dev/null || echo ''") : Promise.resolve("skipped"),
      // login.defs
      (runAll || checks.includes("ssh")) ? readFile("/etc/login.defs", "utf8").catch(() => "") : Promise.resolve("skipped"),
      // kernel security params
      (runAll || checks.includes("firewall")) ? run("sysctl net.ipv4.ip_forward net.ipv4.conf.all.accept_redirects net.ipv4.conf.all.send_redirects net.ipv4.conf.all.rp_filter net.ipv6.conf.all.forwarding 2>/dev/null") : Promise.resolve("skipped"),
      // listening ports
      (runAll || checks.includes("firewall")) ? run("ss -tlnup 2>/dev/null | head -60") : Promise.resolve("skipped"),
      // world-writable files (excluding /proc /sys /dev)
      (runAll || checks.includes("suid")) ? run("find / -xdev -not \\( -path '/proc/*' -o -path '/sys/*' -o -path '/dev/*' \\) -perm -o+w -type f 2>/dev/null | head -30") : Promise.resolve("skipped"),
    ]);

    // ── SSH設定の解析 ──
    type SshSettings = Record<string, string>;
    const sshSettings: SshSettings = {};
    if (sshdConfig !== "skipped") {
      for (const line of sshdConfig.split("\n")) {
        const m = line.match(/^\s*([A-Za-z]+)\s+(.+)/);
        if (m && !line.startsWith("#")) sshSettings[m[1]] = m[2].trim();
      }
    }

    // ── ログイン失敗数の集計 ──
    const failedLoginCount = authLogFail === "skipped" ? null
      : authLogFail.split("\n").filter((l) => l.trim()).length;

    // ── UID 0 アカウント（root以外は問題） ──
    const uid0Accounts = shadowDuplicates === "skipped" ? []
      : shadowDuplicates.split("\n").map((l) => l.trim()).filter(Boolean);

    // ── 空パスワードアカウント ──
    const emptyPasswordAccounts = passwdEmpty === "skipped" ? []
      : passwdEmpty.split("\n").map((l) => l.trim()).filter(Boolean);

    // ── SUID/SGIDファイルの既知以外を検出 ──
    const knownSuid = new Set([
      "/usr/bin/sudo", "/usr/bin/su", "/usr/bin/passwd", "/usr/bin/newgrp",
      "/usr/bin/gpasswd", "/usr/bin/chsh", "/usr/bin/chfn", "/usr/bin/mount",
      "/usr/bin/umount", "/usr/bin/pkexec", "/usr/lib/openssh/ssh-keysign",
      "/usr/lib/dbus-1.0/dbus-daemon-launch-helper", "/usr/sbin/pppd",
      "/usr/bin/fusermount", "/usr/bin/fusermount3", "/usr/bin/ping",
    ]);
    const suidList = suidFiles === "skipped" ? []
      : suidFiles.split("\n").map((l) => l.trim()).filter(Boolean);
    const suspiciousSuid = suidList.filter((f) => !knownSuid.has(f));

    // ── カーネルパラメータ解析 ──
    type KernelParams = Record<string, string>;
    const kernelMap: KernelParams = {};
    if (kernelParams !== "skipped") {
      for (const line of kernelParams.split("\n")) {
        const [k, v] = line.split("=").map((s) => s.trim());
        if (k && v !== undefined) kernelMap[k] = v;
      }
    }

    // ── 問題点と推奨事項の生成 ──
    type Finding = { severity: "critical" | "high" | "medium" | "low" | "info"; item: string; detail: string; recommendation: string };
    const findings: Finding[] = [];

    // Firewall
    if (runAll || checks.includes("firewall")) {
      if (ufwStatus.includes("Status: inactive") || ufwStatus.includes("ufw: not found")) {
        findings.push({
          severity: "high",
          item: "ファイアウォール無効",
          detail: "UFW が無効またはインストールされていません。",
          recommendation: "sudo ufw enable && sudo ufw default deny incoming && sudo ufw allow ssh を実行してファイアウォールを有効化してください。",
        });
      }
      if (kernelMap["net.ipv4.ip_forward"] === "1") {
        findings.push({
          severity: "medium",
          item: "IPフォワード有効",
          detail: "net.ipv4.ip_forward = 1 — ルーター/VPNサーバーでない場合は不要です。",
          recommendation: "sysctl -w net.ipv4.ip_forward=0 を実行し、/etc/sysctl.conf でも無効化してください。",
        });
      }
      if (kernelMap["net.ipv4.conf.all.accept_redirects"] === "1") {
        findings.push({
          severity: "medium",
          item: "ICMPリダイレクト受け入れ有効",
          detail: "net.ipv4.conf.all.accept_redirects = 1 — ルーティングテーブルが改ざんされる可能性があります。",
          recommendation: "sysctl -w net.ipv4.conf.all.accept_redirects=0 を設定してください。",
        });
      }
    }

    // SSH
    if (runAll || checks.includes("ssh")) {
      if (sshSettings["PermitRootLogin"] && !["no", "prohibit-password"].includes(sshSettings["PermitRootLogin"])) {
        findings.push({
          severity: "high",
          item: "SSH root ログイン許可",
          detail: `PermitRootLogin = ${sshSettings["PermitRootLogin"]}`,
          recommendation: "sshd_config で PermitRootLogin prohibit-password または no に設定し、sudo su で作業してください。",
        });
      }
      if (sshSettings["PasswordAuthentication"] === "yes" || !sshSettings["PasswordAuthentication"]) {
        findings.push({
          severity: "medium",
          item: "SSH パスワード認証有効",
          detail: "PasswordAuthentication が yes または未設定（デフォルト yes）です。",
          recommendation: "公開鍵認証のみに制限してください: PasswordAuthentication no",
        });
      }
      if (!sshSettings["Protocol"] || sshSettings["Protocol"] === "2,1" || sshSettings["Protocol"] === "1") {
        // Protocol line absence is fine in modern sshd (defaults to 2 only), warn only if explicitly set to 1
        if (sshSettings["Protocol"] === "1" || sshSettings["Protocol"] === "2,1") {
          findings.push({
            severity: "critical",
            item: "SSH プロトコル v1 有効",
            detail: "SSHv1 は深刻な脆弱性があります。",
            recommendation: "sshd_config で Protocol 2 のみに設定してください。",
          });
        }
      }
      const sshPort = sshSettings["Port"] ?? "22";
      if (sshPort === "22") {
        findings.push({
          severity: "low",
          item: "SSH デフォルトポート使用",
          detail: "SSH がデフォルトの 22 番ポートで待ち受けています。",
          recommendation: "Port を変更すると自動スキャンによるブルートフォース攻撃を低減できます（セキュリティ向上の一助）。",
        });
      }
      const maxAuthTries = parseInt(sshSettings["MaxAuthTries"] ?? "6");
      if (maxAuthTries > 3) {
        findings.push({
          severity: "low",
          item: "SSH 認証試行回数が多い",
          detail: `MaxAuthTries = ${maxAuthTries}`,
          recommendation: "MaxAuthTries 3 に設定してブルートフォースを抑制してください。",
        });
      }
    }

    // Sudo
    if (runAll || checks.includes("sudo")) {
      if (uid0Accounts.some((a) => a !== "root")) {
        findings.push({
          severity: "critical",
          item: "UID 0 のアカウントが root 以外に存在",
          detail: `UID 0 アカウント: ${uid0Accounts.join(", ")}`,
          recommendation: "root 以外の UID 0 アカウントは直ちに調査・削除してください。",
        });
      }
      if (emptyPasswordAccounts.length > 0) {
        findings.push({
          severity: "critical",
          item: "空パスワードのアカウントが存在",
          detail: `対象アカウント: ${emptyPasswordAccounts.join(", ")}`,
          recommendation: "passwd <username> でパスワードを設定するか、アカウントを無効化してください。",
        });
      }
      if (sudoersFiles.includes("NOPASSWD")) {
        findings.push({
          severity: "medium",
          item: "NOPASSWD sudo 設定あり",
          detail: "sudoers に NOPASSWD エントリが存在します。",
          recommendation: "NOPASSWD の使用を最小限にし、必要なコマンドのみに限定してください。",
        });
      }
    }

    // Auth log
    if (runAll || checks.includes("auth_log")) {
      if (failedLoginCount !== null && failedLoginCount >= 10) {
        findings.push({
          severity: "high",
          item: "認証失敗ログが多数検出",
          detail: `直近の認証失敗ログ: ${failedLoginCount} 件`,
          recommendation: "fail2ban などのブルートフォース対策ツールの導入を検討してください。また、認証試行元 IP のブロックを検討してください。",
        });
      }
    }

    // Updates
    if (runAll || checks.includes("updates")) {
      if (unattendedUpgrades.includes("not configured") || !unattendedUpgrades.includes("1")) {
        findings.push({
          severity: "medium",
          item: "自動セキュリティアップデート未設定",
          detail: "unattended-upgrades が無効または未設定です。",
          recommendation: "sudo apt install unattended-upgrades && sudo dpkg-reconfigure unattended-upgrades を実行して自動更新を有効化してください。",
        });
      }
    }

    // SUID/SGID
    if (runAll || checks.includes("suid")) {
      if (suspiciousSuid.length > 0) {
        findings.push({
          severity: "high",
          item: "不審な SUID/SGID ファイル検出",
          detail: `既知リスト外の SUID/SGID ファイル: ${suspiciousSuid.slice(0, 10).join(", ")}`,
          recommendation: "各ファイルが正規のものか確認し、不要であれば chmod u-s/g-s で権限を削除してください。",
        });
      }
      const wwFiles = worldWritable === "skipped" ? []
        : worldWritable.split("\n").map((l) => l.trim()).filter(Boolean);
      if (wwFiles.length > 0) {
        findings.push({
          severity: "medium",
          item: "ワールドライタブルなファイル検出",
          detail: `誰でも書き込み可能なファイル (最大30件): ${wwFiles.slice(0, 5).join(", ")} ...`,
          recommendation: "chmod o-w <file> で不要なワールドライト権限を削除してください。",
        });
      }
    }

    // 重要度でソート
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    findings.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

    // スコア計算（簡易）
    const deductions: Record<string, number> = { critical: 30, high: 15, medium: 7, low: 2, info: 0 };
    const score = Math.max(0, 100 - findings.reduce((s, f) => s + (deductions[f.severity] ?? 0), 0));

    const report = {
      summary: {
        score,
        rating: score >= 80 ? "良好" : score >= 60 ? "要改善" : score >= 40 ? "問題あり" : "危険",
        totalFindings: findings.length,
        bySeverity: {
          critical: findings.filter((f) => f.severity === "critical").length,
          high: findings.filter((f) => f.severity === "high").length,
          medium: findings.filter((f) => f.severity === "medium").length,
          low: findings.filter((f) => f.severity === "low").length,
        },
      },
      findings,
      rawData: {
        firewall: { ufw: ufwStatus, kernelParams: kernelParams },
        ssh: { settings: sshSettings, port: sshSettings["Port"] ?? "22 (default)" },
        auth: { recentFailedLogins: failedLoginCount, journalEntries: journalFail },
        accounts: { uid0Accounts, emptyPasswordAccounts },
        updates: { config: unattendedUpgrades },
        suid: { allFiles: suidList, suspicious: suspiciousSuid },
        listeningPorts,
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  }
);

// ── 9. network_insights ──────────────────────────────────────────────────────
server.registerTool(
  "get_network_insights",
  {
    description:
      "ネットワーク状況を詳細に診断し、接続状態・帯域・ルーティング・DNS・問題検出と改善提案を返します。",
    inputSchema: z.object({
      checks: z
        .array(z.enum(["interfaces", "routing", "dns", "ports", "connections", "bandwidth", "all"]))
        .default(["all"])
        .describe("実施するチェック項目（デフォルト: all）"),
    }),
  },
  async ({ checks }) => {
    const runAll = checks.includes("all");

    const [
      ipAddrJson, ipLinkStats,
      routeTable, ipRoute6,
      dnsResolv, systemdResolve,
      listeningPorts, establishedConns, allConns,
      netDev, ethtoolLo,
      pingGateway, pingDns,
      arpTable,
      nmStatus,
    ] = await Promise.all([
      // interfaces
      (runAll || checks.includes("interfaces")) ? run("ip -j addr 2>/dev/null || ip addr") : Promise.resolve("skipped"),
      (runAll || checks.includes("bandwidth")) ? run("ip -s link 2>/dev/null") : Promise.resolve("skipped"),
      // routing
      (runAll || checks.includes("routing")) ? run("ip route show") : Promise.resolve("skipped"),
      (runAll || checks.includes("routing")) ? run("ip -6 route show 2>/dev/null || echo ''") : Promise.resolve("skipped"),
      // dns
      (runAll || checks.includes("dns")) ? readFile("/etc/resolv.conf", "utf8").catch(() => "not found") : Promise.resolve("skipped"),
      (runAll || checks.includes("dns")) ? run("systemd-resolve --status 2>/dev/null | head -40 || resolvectl status 2>/dev/null | head -40 || echo 'systemd-resolved: unavailable'") : Promise.resolve("skipped"),
      // ports
      (runAll || checks.includes("ports")) ? run("ss -tlnup 2>/dev/null") : Promise.resolve("skipped"),
      (runAll || checks.includes("connections")) ? run("ss -tnp state established 2>/dev/null | head -50") : Promise.resolve("skipped"),
      (runAll || checks.includes("connections")) ? run("ss -s 2>/dev/null") : Promise.resolve("skipped"),
      // bandwidth / stats
      (runAll || checks.includes("bandwidth")) ? readFile("/proc/net/dev", "utf8").catch(() => "") : Promise.resolve("skipped"),
      (runAll || checks.includes("interfaces")) ? run("ethtool lo 2>/dev/null || echo ''") : Promise.resolve("skipped"),
      // connectivity test
      (runAll || checks.includes("routing")) ? run("ip route show | grep default | awk '{print $3}' | head -1").then((gw) => gw ? run(`ping -c 2 -W 2 ${gw} 2>/dev/null`) : Promise.resolve("no default gateway")) : Promise.resolve("skipped"),
      (runAll || checks.includes("dns")) ? run("ping -c 2 -W 2 8.8.8.8 2>/dev/null || echo 'ping to 8.8.8.8 failed'") : Promise.resolve("skipped"),
      // arp
      (runAll || checks.includes("interfaces")) ? run("ip neigh show 2>/dev/null || arp -n 2>/dev/null") : Promise.resolve("skipped"),
      // NetworkManager
      (runAll || checks.includes("interfaces")) ? run("nmcli general status 2>/dev/null || echo 'NetworkManager: unavailable'") : Promise.resolve("skipped"),
    ]);

    // ── インターフェース解析 ──
    type InterfaceInfo = { name: string; state: string; addresses: string[]; flags: string[] };
    let interfaces: InterfaceInfo[] = [];
    try {
      const parsed = JSON.parse(ipAddrJson);
      interfaces = parsed.map((iface: Record<string, unknown>) => ({
        name: iface.ifname as string,
        state: iface.operstate as string,
        flags: (iface.flags as string[]) ?? [],
        addresses: ((iface.addr_info as Array<Record<string, unknown>>) ?? []).map(
          (a) => `${a.family}:${a.local}/${a.prefixlen}`
        ),
      }));
    } catch {
      // JSON解析失敗時はテキストをそのまま使用
    }

    // ── /proc/net/dev 解析 ──
    type BandwidthStats = Record<string, { rxBytes: number; txBytes: number; rxErrors: number; txErrors: number; rxDropped: number; txDropped: number }>;
    const bwStats: BandwidthStats = {};
    if (netDev !== "skipped") {
      for (const line of netDev.split("\n").slice(2)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        const name = parts[0].replace(":", "");
        bwStats[name] = {
          rxBytes: parseInt(parts[1]),
          rxErrors: parseInt(parts[3]),
          rxDropped: parseInt(parts[4]),
          txBytes: parseInt(parts[9]),
          txErrors: parseInt(parts[11]),
          txDropped: parseInt(parts[12]),
        };
      }
    }

    // ── DNS サーバー抽出 ──
    const dnsServers: string[] = [];
    if (dnsResolv !== "skipped") {
      for (const line of dnsResolv.split("\n")) {
        const m = line.match(/^nameserver\s+(.+)/);
        if (m) dnsServers.push(m[1].trim());
      }
    }

    // ── リスニングポート解析 ──
    type PortInfo = { proto: string; localAddr: string; process: string };
    const portList: PortInfo[] = [];
    if (listeningPorts !== "skipped") {
      for (const line of listeningPorts.split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          portList.push({ proto: parts[0], localAddr: parts[4], process: parts[parts.length - 1] });
        }
      }
    }

    // ── 確立された接続数 ──
    const establishedCount = establishedConns === "skipped" ? null
      : establishedConns.split("\n").filter((l) => l.trim()).length - 1;

    // ── 問題検出と推奨事項 ──
    type NetFinding = { severity: "critical" | "high" | "medium" | "low" | "info"; item: string; detail: string; recommendation: string };
    const findings: NetFinding[] = [];

    // インターフェース
    if (runAll || checks.includes("interfaces")) {
      const downIfaces = interfaces.filter(
        (i) => i.state === "DOWN" && !i.flags.includes("LOOPBACK")
      );
      if (downIfaces.length > 0) {
        findings.push({
          severity: "medium",
          item: "ダウン状態のネットワークインターフェース検出",
          detail: `DOWN 状態: ${downIfaces.map((i) => i.name).join(", ")}`,
          recommendation: "ip link set <interface> up または netplan apply でインターフェースを有効化してください。",
        });
      }

      // エラー・ドロップが多いインターフェース
      for (const [iface, stats] of Object.entries(bwStats)) {
        if (stats.rxErrors > 1000 || stats.txErrors > 1000) {
          findings.push({
            severity: "medium",
            item: `${iface}: ネットワークエラーが多い`,
            detail: `RX errors: ${stats.rxErrors}, TX errors: ${stats.txErrors}`,
            recommendation: "ケーブルやNICの物理的な問題、またはドライバーの問題を確認してください。ethtool <interface> で詳細を確認できます。",
          });
        }
        if (stats.rxDropped > 5000 || stats.txDropped > 5000) {
          findings.push({
            severity: "low",
            item: `${iface}: パケットドロップが多い`,
            detail: `RX dropped: ${stats.rxDropped}, TX dropped: ${stats.txDropped}`,
            recommendation: "バッファサイズの拡大（sysctl net.core.rmem_max 等）やネットワーク負荷の軽減を検討してください。",
          });
        }
      }
    }

    // ルーティング
    if (runAll || checks.includes("routing")) {
      if (routeTable === "skipped" || !routeTable.includes("default")) {
        findings.push({
          severity: "high",
          item: "デフォルトゲートウェイが設定されていない",
          detail: "ip route にデフォルトルートが存在しません。",
          recommendation: "ip route add default via <gateway_ip> dev <interface> でデフォルトゲートウェイを設定してください。",
        });
      }
      if (pingGateway !== "skipped" && (pingGateway.includes("100% packet loss") || pingGateway.includes("unreachable"))) {
        findings.push({
          severity: "high",
          item: "デフォルトゲートウェイへの疎通なし",
          detail: pingGateway.split("\n").slice(-3).join(" "),
          recommendation: "ゲートウェイのIPアドレス設定、物理接続、ルーターの状態を確認してください。",
        });
      }
    }

    // DNS
    if (runAll || checks.includes("dns")) {
      if (dnsServers.length === 0) {
        findings.push({
          severity: "high",
          item: "DNSサーバーが設定されていない",
          detail: "/etc/resolv.conf に nameserver エントリがありません。",
          recommendation: "/etc/resolv.conf に nameserver 8.8.8.8 を追加するか、systemd-resolved を設定してください。",
        });
      }
      if (pingDns !== "skipped" && pingDns.includes("100% packet loss")) {
        findings.push({
          severity: "high",
          item: "外部ネットワーク (8.8.8.8) への疎通なし",
          detail: "インターネット接続が確認できません。",
          recommendation: "ルーターやISPの接続状態、ファイアウォールルールを確認してください。",
        });
      }
      if (dnsServers.includes("127.0.0.1") || dnsServers.includes("127.0.0.53")) {
        findings.push({
          severity: "info",
          item: "ループバックDNS使用中",
          detail: `DNSサーバー: ${dnsServers.join(", ")} — systemd-resolved 等のローカルリゾルバー使用中。`,
          recommendation: "正常な構成ですが、systemd-resolved が稼働していることを resolvectl status で確認してください。",
        });
      }
    }

    // 待受ポート（外部公開のリスクチェック）
    if (runAll || checks.includes("ports")) {
      const sensitivePortMap: Record<string, string> = {
        "23": "Telnet（平文通信）",
        "21": "FTP（平文通信）",
        "69": "TFTP",
        "512": "rsh/rexec",
        "513": "rlogin",
        "514": "rsh",
        "2049": "NFS",
        "111": "RPC portmapper",
        "6000": "X11",
      };
      for (const { localAddr } of portList) {
        const port = localAddr.split(":").pop() ?? "";
        if (sensitivePortMap[port]) {
          findings.push({
            severity: "high",
            item: `危険なポートが公開されている: ${port}/${sensitivePortMap[port]}`,
            detail: `${localAddr} で ${sensitivePortMap[port]} が待ち受けています。`,
            recommendation: `${sensitivePortMap[port]} は安全ではありません。サービスを停止するか、SSH トンネリングなどに移行してください。`,
          });
        }
      }
    }

    // 接続数が異常に多い
    if (runAll || checks.includes("connections")) {
      if (establishedCount !== null && establishedCount > 500) {
        findings.push({
          severity: "medium",
          item: "確立済みTCP接続数が多い",
          detail: `ESTABLISHED: ${establishedCount} 接続`,
          recommendation: "ss -tnp state established でプロセスごとの接続を確認し、異常な接続元をブロックすることを検討してください。",
        });
      }
    }

    // 重要度でソート
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    findings.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

    const report = {
      summary: {
        totalFindings: findings.length,
        bySeverity: {
          critical: findings.filter((f) => f.severity === "critical").length,
          high: findings.filter((f) => f.severity === "high").length,
          medium: findings.filter((f) => f.severity === "medium").length,
          low: findings.filter((f) => f.severity === "low").length,
          info: findings.filter((f) => f.severity === "info").length,
        },
        externalConnectivity: pingDns === "skipped" ? "unchecked"
          : pingDns.includes("100% packet loss") ? "unreachable" : "ok",
        gatewayConnectivity: pingGateway === "skipped" ? "unchecked"
          : (pingGateway.includes("100% packet loss") || pingGateway.includes("unreachable")) ? "unreachable" : "ok",
      },
      findings,
      network: {
        interfaces: interfaces.length > 0 ? interfaces : ipAddrJson,
        bandwidthStats: bwStats,
        dnsServers,
        defaultRoutes: (routeTable === "skipped" ? "" : routeTable).split("\n").filter((l) => l.startsWith("default")),
        listeningPorts: portList,
        establishedConnections: establishedCount,
        connectionSummary: allConns,
        arpTable,
        networkManager: nmStatus,
      },
      rawData: {
        ipLinkStats,
        ipRoute: routeTable,
        ipRoute6,
        resolvConf: dnsResolv,
        systemdResolve,
        pingGateway,
        pingExternal: pingDns,
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  }
);

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-ubuntu-insights running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
