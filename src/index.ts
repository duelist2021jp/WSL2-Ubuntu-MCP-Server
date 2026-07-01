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

const server = new McpServer({ name: "mcp-ubuntu-insights", version: "0.1.0" });

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
