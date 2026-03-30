const express = require("express");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const SUPPORT_ROOM_ID = process.env.SUPPORT_ROOM_ID;
const KNOWLEDGE_ROOM_ID = process.env.KNOWLEDGE_ROOM_ID;

const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });
const knowledgePath = path.resolve(__dirname, "knowledge.txt");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 処理済みIDを記録（重複防止）
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

// 質問に関連するナレッジをベクトル検索で取得
async function searchKnowledge(query) {
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: query,
  });
  const queryEmbedding = response.data[0].embedding;

  const { data, error } = await supabase.rpc("match_knowledge", {
    query_embedding: queryEmbedding,
    match_count: 5,
  });

  if (error) {
    console.error("Supabase検索エラー:", error);
    return "";
  }

  const result = data.map((d) => d.content).join("\n\n");
  console.log(`RAG: ${data.length}チャンク取得, 合計${result.length}文字`);
  return result;
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

// Claude APIでAI宮下の返答を生成（RAG適用）
async function generateReply(userMessage) {
  const relevantKnowledge = await searchKnowledge(userMessage);

  const systemPrompt =
    relevantKnowledge +
    "\n\n" +
    "あなたはAI宮下です。上記ナレッジに基づいてのみ回答しろ。" +
    "ナレッジに記載のない内容は絶対に答えるな。" +
    "その場合は「それはナレッジにないので宮下本人に確認してくださいっす」と返せ。" +
    "語尾は〜っすね、wなど宮下さんらしい言葉遣いで。" +
    "部下のマーケ責任者・マーケPを育成する壁打ち相手として厳しくも愛のある返答をしろ。";

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
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
  res.status(200).send("OK");
  handleWebhook(req.body).catch((err) => {
    console.error("Webhook処理エラー:", err);
  });
});

async function handleWebhook(body) {
  console.log("Webhook受信:", JSON.stringify(body).substring(0, 300));

  const event = body.webhook_event;
  if (!event || !event.body) return;

  if (String(event.account_id) === "10832038") {
    console.log("ボット自身のメッセージをスキップ");
    return;
  }

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
  console.log("RAG mode: Supabase + OpenAI ベクトル検索");
});