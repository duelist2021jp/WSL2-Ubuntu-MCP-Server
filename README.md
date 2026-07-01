# mcp-ubuntu-insights

Ubuntu のシステム情報・リソース使用量を Bob に提供する MCP サーバーです。  
CPU・メモリ・ディスク・ネットワーク・サービス・プロセスの情報を自然言語で問い合わせられるようになります。

## 動作環境

| 項目 | 要件 |
|---|---|
| OS | Ubuntu 24.04 LTS（WSL2 含む） |
| Node.js | v18 以上 |
| MCP クライアント | IBM Bob |

---

## ディレクトリ構成

```
mcp-ubuntu-insights/
├── src/
│   └── index.ts        # サーバー実装（TypeScript）
├── build/
│   └── index.js        # コンパイル済みバイナリ（自動生成）
├── package.json
├── tsconfig.json
└── README.md
```

登録設定ファイル（ワークスペーススコープ）:

```
<ワークスペース>/
└── .bob/
    └── mcp.json        # Bob への MCP サーバー登録
```

---

## セットアップ手順

まず Node.js がインストール済みかどうかを確認してください。

```bash
node --version
npm --version
```

- **`v18.0.0` 以上が表示された場合** → [手順 A（インストール済み）](#手順-a-nodejs-インストール済みの場合) へ
- **`command not found` と表示された場合** → [手順 B（未インストール）](#手順-b-nodejs-未インストールの場合nvm-経由) へ

---

## 手順 A：Node.js インストール済みの場合

### A-1. リポジトリのクローン

```bash
git clone https://github.com/<your-username>/mcp-ubuntu-insights.git
cd mcp-ubuntu-insights
```

### A-2. 依存パッケージのインストールとビルド

```bash
npm install
npm run build
```

成功すると `build/index.js` が生成されます。

```bash
ls build/   # index.js が存在すれば OK
```

### A-3. Bob への登録（`mcp.json`）

`node` の絶対パスを確認します。

```bash
which node
# 例（システム標準）: /usr/bin/node
# 例（nvm）         : /home/testuser/.nvm/versions/node/v24.18.0/bin/node
```

ワークスペース内の `.bob/mcp.json` を作成または編集して以下を追加します。
**パスは `which node` と `pwd` の結果に合わせて変更してください。**

```bash
# build/index.js の絶対パスを確認
pwd   # 例: /home/testuser/bob-study/mcp-ubuntu-insights
```

**`.bob/mcp.json`**（ワークスペースルートの `.bob/` ディレクトリに配置）

```json
{
  "mcpServers": {
    "ubuntu-insights": {
      "command": "/usr/bin/node",
      "args": ["/home/youruser/path/to/mcp-ubuntu-insights/build/index.js"]
    }
  }
}
```

### A-4. 接続確認

`mcp.json` を保存すると Bob がホットリロードし、MCP パネルに `ubuntu-insights` が表示されます。
表示されない場合は Bob を再起動してください。

動作確認（コマンドラインから直接テスト）:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  | node build/index.js
# {"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},...}}
```

---

## 手順 B：Node.js 未インストールの場合（nvm 経由）

### B-1. nvm のインストール

```bash
# nvm のインストール
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# シェルに nvm を読み込む
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Node.js LTS をインストール
nvm install --lts

# バージョン確認
node --version   # 例: v24.18.0
npm --version    # 例: 11.16.0
```

> **注意**: 次回以降のシェル起動時も nvm が自動的に読み込まれるよう、インストーラーが
> `~/.bashrc` へ追記します。手動で追加する場合は以下を `~/.bashrc` に記述してください。
>
> ```bash
> export NVM_DIR="$HOME/.nvm"
> [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
> ```

### B-2. リポジトリのクローン・ビルド

```bash
git clone https://github.com/<your-username>/mcp-ubuntu-insights.git
cd mcp-ubuntu-insights
npm install
npm run build
```

### B-3. Bob への登録（`mcp.json`）

nvm でインストールした Node.js の絶対パスを確認します。

```bash
which node
# 例: /home/testuser/.nvm/versions/node/v24.18.0/bin/node
```

> **重要**: Bob は `~/.bashrc` を読み込まないため `PATH` に nvm のパスが通っていません。
> `command` には `node` ではなく必ず **絶対パス** を指定してください。

**`.bob/mcp.json`**（ワークスペースルートの `.bob/` ディレクトリに配置）

```json
{
  "mcpServers": {
    "ubuntu-insights": {
      "command": "/home/testuser/.nvm/versions/node/v24.18.0/bin/node",
      "args": ["/home/testuser/bob-study/mcp-ubuntu-insights/build/index.js"]
    }
  }
}
```

### B-4. 接続確認

`mcp.json` を保存すると Bob がホットリロードし、MCP パネルに `ubuntu-insights` が表示されます。
表示されない場合は Bob を再起動してください。

動作確認（コマンドラインから直接テスト）:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  | node build/index.js
# {"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},...}}
```

---

## ゼロからスクラッチで構築する場合

GitHub からクローンせず、自分でファイルを作成する場合の手順です。

### 2. プロジェクトのセットアップ

ワークスペース内にプロジェクトディレクトリを作成し、依存パッケージをインストールします。

```bash
# ワークスペースへ移動（例）
cd /home/testuser/bob-study

# ディレクトリ作成
mkdir -p mcp-ubuntu-insights/src
cd mcp-ubuntu-insights

# package.json の初期化（後述の内容で上書きします）
npm init -y

# 依存パッケージのインストール
npm install @modelcontextprotocol/sdk zod
npm install -D @types/node typescript
```

### 3. 設定ファイルの作成

**`package.json`**

```json
{
  "name": "mcp-ubuntu-insights",
  "version": "0.1.0",
  "description": "MCP server for Ubuntu system insights",
  "type": "module",
  "scripts": {
    "build": "tsc && chmod 755 build/index.js"
  },
  "bin": {
    "mcp-ubuntu-insights": "./build/index.js"
  },
  "files": ["build"],
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.20.0",
    "typescript": "^5.9.3"
  }
}
```

**`tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### 4. サーバー実装（`src/index.ts`）

`src/index.ts` を作成します。詳細は [`src/index.ts`](src/index.ts) を参照してください。  
ファイルの骨格は以下の通りです。

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// ...（各ツールの registerTool 呼び出し）

const server = new McpServer({ name: "mcp-ubuntu-insights", version: "0.1.0" });

// ツールを登録 → server.registerTool("ツール名", { description, inputSchema }, handler)

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-ubuntu-insights running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
```

> **ログは必ず `console.error` を使用してください。**  
> `console.log` は MCP プロトコルの stdout チャネルに書き込まれるため、接続が壊れます。

### 5. ビルド

```bash
# mcp-ubuntu-insights ディレクトリで実行
npm run build
```

成功すると `build/index.js` が生成されます。

```bash
ls build/   # index.js が存在すれば OK
```

### 6. Bob への登録（`mcp.json`）

ワークスペース内の `.bob/mcp.json` にサーバーを登録します。
**`node` の絶対パスと `build/index.js` の絶対パスは環境に合わせて変更してください。**
→ 詳細は [手順 A-3](#a-3-bob-への登録mcp-json) または [手順 B-3](#b-3-bob-への登録mcp-json) を参照してください。

> - **ワークスペーススコープ**（`.bob/mcp.json`）: このワークスペースを開いている間のみ有効
> - **グローバルスコープ**（`~/.bob/settings/mcp.json`）: 全ワークスペースで有効
> 同名のサーバーはワークスペーススコープがグローバルスコープを上書きします。

### 7. 接続確認

`mcp.json` を保存すると Bob がホットリロードし、MCP パネルに `ubuntu-insights` が表示されます。
表示されない場合は Bob を再起動してください。

---

## 提供ツール一覧

| ツール名 | 説明 | パラメーター |
|---|---|---|
| `get_system_overview` | OS・稼働時間・CPU/メモリ/ディスクの総合概要 | なし |
| `get_cpu_info` | CPUモデル・コア数・ロードアベレージ | なし |
| `get_memory_info` | メモリ・スワップ詳細（`/proc/meminfo` + `free -m`） | なし |
| `get_disk_info` | `df -h` + `lsblk` のディスク情報 | なし |
| `get_network_info` | IPアドレス・接続状況・送受信統計 | なし |
| `get_running_services` | systemd サービス一覧 | `state`: `running`（既定）/ `failed` / `all` |
| `get_top_processes` | リソース消費上位プロセス | `sortBy`: `cpu`（既定）/ `memory`、`limit`: 1〜50（既定 15） |

### 使い方の例

Bob のチャットで以下のように質問できます。

```
システムの概要を教えて
CPU の負荷を確認して
メモリ使用量を詳しく見せて
失敗しているサービスはある？
メモリ消費上位 20 件のプロセスを教えて
```

---

## ツールの追加・拡張

新しいツールを追加するには `src/index.ts` に `server.registerTool(...)` を追記し、ビルドし直します。

```bash
# 編集後にビルド
cd /home/testuser/bob-study/mcp-ubuntu-insights
npm run build
```

ビルドが完了すると Bob が自動的に新しいツールを認識します（再起動不要）。

---

## トラブルシューティング

### MCP パネルにサーバーが表示されない

1. Bob を再起動する
2. `.bob/mcp.json` の JSON 構文エラーがないか確認する
3. `node` と `build/index.js` のパスが正しい絶対パスであることを確認する
4. コマンドラインから直接実行して起動エラーがないか確認する（上記「接続確認」参照）

### `node: command not found` になる

`mcp.json` の `command` には `node` ではなく **nvm でインストールした Node.js の絶対パス** を指定してください。  
Bob は nvm のシェル設定（`~/.bashrc`）を読み込まないため、`PATH` に nvm のパスが通っていません。

```bash
# 正しい絶対パスを確認
which node
```

### ビルドエラーが出る

TypeScript のバージョンや `@modelcontextprotocol/sdk` の API 変更が原因の場合があります。

```bash
# 依存パッケージを最新化して再ビルド
npm update
npm run build
```
