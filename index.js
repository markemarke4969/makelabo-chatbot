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
const knowledgePath = path.join(__dirname, "knowledge.txt");

// ナレッジファイル読み込み
function loadKnowledge() {
  try {
    return fs.readFileSync(knowledgePath, "utf-8");
  } catch {
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
    "あなたはAI宮下です。上記ナレッジに基づいて、" +
    "部下のマーケ責任者・マーケPを育成する壁打ち相手として" +
    "厳しくも愛のある返答をしてください。" +
    "語尾は〜っすね、wなど宮下さんらしい言葉遣いで。" +
    "ナレッジにない情報は推測で答えず確認を促すこと。";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
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
app.post("/webhook", async (req, res) => {
  // Webhookの検証リクエストには即座に200を返す
  res.status(200).send("OK");

  try {
    const event = req.body.webhook_event;
    if (!event || !event.body) return;

    const roomId = String(event.room_id);
    const messageBody = event.body;

    // ナレッジ更新用ルーム
    if (roomId === KNOWLEDGE_ROOM_ID) {
      fs.writeFileSync(knowledgePath, messageBody, "utf-8");
      console.log("knowledge.txt updated");
      await sendChatworkMessage(
        roomId,
        "ナレッジを更新しました。"
      );
      return;
    }

    // サポート用ルーム
    if (roomId === SUPPORT_ROOM_ID) {
      const reply = await generateReply(messageBody);
      await sendChatworkMessage(roomId, reply);
      return;
    }
  } catch (err) {
    console.error("Webhook処理エラー:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
