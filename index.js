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

// 確認待ちのナレッジ追記を一時保存
// { roomId: { formattedText, section } }
const pendingKnowledge = new Map();

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

// ナレッジ追記の整形・分析
async function analyzeAndFormatKnowledge(rawText) {
  const knowledge = fs.readFileSync(knowledgePath, "utf-8");
  const first3000 = knowledge.substring(0, 3000);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    system:
      "あなたはナレッジ管理の専門家です。" +
      "ユーザーが入力した一言メモを、ナレッジベースに追記するための整形された文章に変換してください。" +
      "また、既存ナレッジの構成を見て、どのセクションに追記すべきか判断してください。" +
      "必ず以下のJSON形式のみで返してください。他の文章は一切不要です：\n" +
      '{"section": "追加すべきセクション名", "formatted": "整形した文章"}',
    messages: [
      {
        role: "user",
        content:
          `既存ナレッジの冒頭（参考）:\n${first3000}\n\n` +
          `追記したい内容（一言メモ）:\n${rawText}`,
      },
    ],
  });

  try {
    const text = response.content[0].text;
    const json = JSON.parse(text);
    return json;
  } catch (e) {
    console.error("JSON解析エラー:", e);
    return {
      section: "その他",
      formatted: rawText,
    };
  }
}

// Supabaseに追加分だけベクトル登録
async function appendToSupabase(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: text,
  });
  const embedding = response.data[0].embedding;

  const { error } = await supabase
    .from("knowledge_chunks")
    .insert({ content: text, embedding });

  if (error) {
    console.error("Supabase追記エラー:", error);
    return false;
  }
  return true;
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
  const messageBody = event.body.trim();

  // ナレッジ更新用ルーム
  if (roomId === KNOWLEDGE_ROOM_ID) {
    // 「OK」と返信された場合 → 確認済みで登録
    if (messageBody === "OK" || messageBody === "ok" || messageBody === "ｏｋ") {
      const pending = pendingKnowledge.get(roomId);
      if (!pending) {
        await sendChatworkMessage(roomId, "確認待ちのナレッジがありません。追記したい内容を投稿してください。");
        return;
      }

      // knowledge.txtに追記
      fs.appendFileSync(knowledgePath, "\n\n" + pending.formatted, "utf-8");
      console.log("knowledge.txt追記完了:", pending.formatted.substring(0, 50));

      // Supabaseに追記
      const success = await appendToSupabase(pending.formatted);

      pendingKnowledge.delete(roomId);

      if (success) {
        await sendChatworkMessage(roomId, "✅ ナレッジに追記しました！\n\n追記内容：\n" + pending.formatted);
      } else {
        await sendChatworkMessage(roomId, "⚠️ knowledge.txtへの追記は完了しましたが、Supabaseへの登録に失敗しました。");
      }
      return;
    }

    // 「キャンセル」の場合
    if (messageBody === "キャンセル" || messageBody === "cancel") {
      pendingKnowledge.delete(roomId);
      await sendChatworkMessage(roomId, "キャンセルしました。");
      return;
    }

    // 通常の投稿 → 分析・整形して確認メッセージを返す
    await sendChatworkMessage(roomId, "分析中...少々お待ちください⏳");

    const result = await analyzeAndFormatKnowledge(messageBody);
    pendingKnowledge.set(roomId, result);

    const confirmMessage =
      "【ナレッジ追記の確認】\n" +
      "━━━━━━━━━━━━━━\n" +
      `追加場所：${result.section}\n\n` +
      `追加内容：\n${result.formatted}\n` +
      "━━━━━━━━━━━━━━\n" +
      "「OK」と返信で登録します\n" +
      "「キャンセル」で取り消せます";

    await sendChatworkMessage(roomId, confirmMessage);
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