const express = require("express");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const SUPPORT_ROOM_ID = process.env.SUPPORT_ROOM_ID;
const KNOWLEDGE_ROOM_ID = process.env.KNOWLEDGE_ROOM_ID;

const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });
const knowledgePath = path.resolve(__dirname, "knowledge.txt");

// 処理済みIDを記録（重複防止：message_id + webhook_event_id 両方チェック）
const processedIds = new Set();
const MAX_PROCESSED = 10000;

function isDuplicate(id) {
  if (!id) return false;
  const key = String(id);
  if (processedIds.has(key)) return true;
  if (processedIds.size >= MAX_PROCESSED) processedIds.clear();
  processedIds.add(key);
  return false;
}

// ナレッジファイル読み込み
function loadKnowledge() {
  console.log("knowledge.txt パス:", knowledgePath);
  console.log("ファイル存在:", fs.existsSync(knowledgePath));
  try {
    const content = fs.readFileSync(knowledgePath, "utf-8");
    console.log("knowledge.txt 読み込み成功 (文字数:", content.length, ")");
    console.log("knowledge.txt 先頭100文字:", content.substring(0, 100));
    return content;
  } catch (err) {
    console.error("knowledge.txt 読み込み失敗:", err.message);
    return "";
  }
}

// Chatworkにメッセージ送信
async function sendChatworkMessage(roomId, message) {
  const res = await fetch(
    `https://api.chatwork.com/v2/rooms/${roomId}/messages`,
    {
      method: "POST",
      headers: {
        "X-ChatWorkToken": CHATWORK_API_TOKEN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ body: message }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    console.error("Chatwork API error:", res.status, text);
  }
}

// Claude APIでAI宮下の返答を生成
async function generateReply(userMessage) {
  const knowledge = loadKnowledge();
  const systemPrompt =
    knowledge +
    "\n\n" +
    "あなたはAI宮下です。上記ナレッジに基づいてのみ回答しろ。" +
    "ナレッジに記載のない内容は絶対に答えるな。" +
    "その場合は「それはナレッジにないので宮下本人に確認してくださいっす」と返せ。" +
    "語尾は〜っすね、wなど宮下さんらしい言葉遣いで。" +
    "部下のマーケ責任者・マーケPを育成する壁打ち相手として厳しくも愛のある返答をしろ。";

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  return response.content[0].text;
}

// ヘルスチェック
app.get("/", (_req, res) => {
  res.send("AI宮下 bot is running");
});

// Chatwork Webhook受信
app.post("/webhook", (req, res) => {
  // ①即座に200を返す（Chatworkの再送を防ぐ）
  res.status(200).send("OK");

  // ②非同期で処理を実行
  handleWebhook(req.body).catch((err) => {
    console.error("Webhook処理エラー:", err);
  });
});

async function handleWebhook(body) {
  console.log("Webhook受信:", JSON.stringify(body).substring(0, 300));

  const event = body.webhook_event;
  if (!event || !event.body) return;

// ボット自身のメッセージを無視
  if (String(event.account_id) === "10832038") {
    console.log("ボット自身のメッセージをスキップ");
    return;
  }

  // message_idで重複チェック（webhook_event_idがある場合はそちらも併用）
  const messageId = event.message_id;
  const webhookEventId = body.webhook_event_id;

  if (messageId && isDuplicate(`msg_${messageId}`)) {
    console.log("重複message_idをスキップ:", messageId);
    return;
  }
  if (webhookEventId && isDuplicate(`webhook_${webhookEventId}`)) {
    console.log("重複webhook_event_idをスキップ:", webhookEventId);
    return;
  }

  const roomId = String(event.room_id);
  const messageBody = event.body;

  // ナレッジ更新用ルーム
  if (roomId === KNOWLEDGE_ROOM_ID) {
    fs.writeFileSync(knowledgePath, messageBody, "utf-8");
    console.log("knowledge.txt updated (文字数:", messageBody.length, ")");
    console.log("書き込み内容 先頭100文字:", messageBody.substring(0, 100));
    // 書き込み後の読み戻し確認
    const verify = fs.readFileSync(knowledgePath, "utf-8");
    console.log("書き込み後の読み戻し確認 (文字数:", verify.length, ")");
    await sendChatworkMessage(roomId, "ナレッジを更新しました。");
    return;
  }

  // サポート用ルーム
  if (roomId === SUPPORT_ROOM_ID) {
    const reply = await generateReply(messageBody);
    await sendChatworkMessage(roomId, reply);
    return;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("__dirname:", __dirname);
  console.log("knowledge.txt 絶対パス:", knowledgePath);

  if (fs.existsSync(knowledgePath)) {
    const content = loadKnowledge();
    console.log(`ナレッジ読み込み完了：${content.length}文字`);
  } else {
    console.warn("knowledge.txt が見つかりません。パス:", knowledgePath);
    // 空ファイルを作成しておく
    fs.writeFileSync(knowledgePath, "", "utf-8");
    console.log("空のknowledge.txtを作成しました");
  }
});
