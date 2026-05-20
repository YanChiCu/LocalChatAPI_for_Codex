const http = require("http");

const PORT = 8085;
const TARGET_BASE = "http://127.0.0.1:8084/v1";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function extractTextFromContent(content) {
  if (!content) return "";

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === "string") return part;
      if (part.text) return part.text;
      if (part.type === "input_text" && part.text) return part.text;
      if (part.type === "output_text" && part.text) return part.text;
      return "";
    }).join("");
  }

  if (typeof content === "object") {
    if (content.text) return content.text;
  }

  return "";
}

function responsesInputToMessages(body) {
  const messages = [];

  if (body.instructions) {
    messages.push({
      role: "system",
      content: body.instructions
    });
  }

  const input = body.input;

  if (typeof input === "string") {
    messages.push({
      role: "user",
      content: input
    });
    return messages;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;

      if (typeof item === "string") {
        messages.push({
          role: "user",
          content: item
        });
        continue;
      }

      if (item.role) {
        let role = item.role;

        if (role === "developer") {
          role = "system";
        }

        if (!["system", "user", "assistant"].includes(role)) {
          role = "user";
        }

        messages.push({
          role,
          content: extractTextFromContent(item.content)
        });
      }
    }
  }

  if (messages.length === 0) {
    messages.push({
      role: "user",
      content: ""
    });
  }

  return messages;
}

function writeSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function proxyModels(req, res) {
  const upstream = await fetch(`${TARGET_BASE}/models`, {
    method: "GET",
    headers: {
      "Authorization": req.headers["authorization"] || "Bearer sk-local"
    }
  });

  const text = await upstream.text();

  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/json"
  });
  res.end(text);
}

async function handleResponses(req, res) {
  let body;

  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  const stream = body.stream !== false;
  const model = body.model || "gpt-5.5";

  const chatBody = {
    model,
    messages: responsesInputToMessages(body),
    stream
  };

  /**
   * 暂时不要把 Responses API 的复杂字段传下去。
   * 比如 tools、reasoning、parallel_tool_calls、previous_response_id 等。
   * 你的 8084 adapter 目前大概率处理不了这些。
   */

  const upstream = await fetch(`${TARGET_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": req.headers["authorization"] || "Bearer sk-local"
    },
    body: JSON.stringify(chatBody)
  });

  if (!upstream.ok) {
    const errorText = await upstream.text();
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(errorText);
    return;
  }

  const responseId = `resp_${Date.now()}`;

  if (!stream) {
    const json = await upstream.json();
    const text = json?.choices?.[0]?.message?.content || "";

    const responseBody = {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model,
      output: [
        {
          id: `msg_${Date.now()}`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text
            }
          ]
        }
      ],
      usage: json.usage || null
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responseBody));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  writeSSE(res, "response.created", {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model,
      output: []
    }
  });

  writeSSE(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: `msg_${Date.now()}`,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: []
    }
  });

  writeSSE(res, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: `msg_${Date.now()}`,
    output_index: 0,
    content_index: 0,
    part: {
      type: "output_text",
      text: ""
    }
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();

      if (data === "[DONE]") {
        continue;
      }

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      const delta = chunk?.choices?.[0]?.delta?.content;

      if (delta) {
        fullText += delta;

        writeSSE(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta
        });
      }
    }
  }

  writeSSE(res, "response.output_text.done", {
    type: "response.output_text.done",
    output_index: 0,
    content_index: 0,
    text: fullText
  });

  writeSSE(res, "response.content_part.done", {
    type: "response.content_part.done",
    output_index: 0,
    content_index: 0,
    part: {
      type: "output_text",
      text: fullText
    }
  });

  writeSSE(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: fullText
        }
      ]
    }
  });

  writeSSE(res, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model,
      output: [
        {
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: fullText
            }
          ]
        }
      ]
    }
  });

  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    console.log(`[Shim] ${req.method} ${req.url}`);

    if (req.method === "GET" && req.url === "/v1/models") {
      await proxyModels(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/v1/responses") {
      await handleResponses(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  } catch (e) {
    console.error("[Shim Error]", e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: e.message || String(e)
    }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("========================================");
  console.log("  Codex Responses Shim 已启动");
  console.log("========================================");
  console.log(`  监听地址: http://127.0.0.1:${PORT}/v1`);
  console.log(`  转发目标: ${TARGET_BASE}`);
  console.log("========================================");
});
