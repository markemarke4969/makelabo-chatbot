# AI宮下 Chatworkボット

ChatworkのWebhookを受け取り、Claude APIを使って「AI宮下」として返信するボットです。

## セットアップ

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 環境変数

以下の環境変数が必要です（Render.comのEnvironment Variablesに設定）：

| 変数名 | 説明 |
|---|---|
| `CHATWORK_API_TOKEN` | Chatwork APIトークン |
| `CLAUDE_API_KEY` | Anthropic APIキー |
| `SUPPORT_ROOM_ID` | サポート用チャットルームID |
| `KNOWLEDGE_ROOM_ID` | ナレッジ更新用チャットルームID |

### 3. ローカルで動作確認

```bash
# .envファイルは使わず、直接環境変数を指定して起動
CHATWORK_API_TOKEN=xxx CLAUDE_API_KEY=xxx SUPPORT_ROOM_ID=123 KNOWLEDGE_ROOM_ID=456 npm start
```

## Render.comへのデプロイ手順

1. GitHubにこのリポジトリをpushする
2. [Render.com](https://render.com) にログイン
3. **New > Web Service** を選択
4. GitHubリポジトリを接続
5. 以下を設定：
   - **Name**: `makelabo-chatbot`（任意）
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
6. **Environment Variables** に上記4つの環境変数を追加
7. **Create Web Service** をクリック

デプロイ後、表示されるURL（例: `https://makelabo-chatbot.onrender.com`）を控える。

## Chatwork Webhook設定

1. [Chatwork Webhook管理画面](https://www.chatwork.com/service/packages/chatwork/subpackages/webhook/list.php) を開く
2. **Webhook新規作成** をクリック
3. 以下を設定：
   - **Webhook URL**: `https://<your-render-url>/webhook`
   - **イベント**: メッセージ作成
   - **ルーム**: サポート用ルームとナレッジ更新用ルームそれぞれで作成
4. 保存

## 動作仕様

- **サポート用ルーム**: メッセージを受信するとClaude APIで返答を生成して返信
- **ナレッジ更新用ルーム**: メッセージを受信するとその内容で `knowledge.txt` を上書き保存
