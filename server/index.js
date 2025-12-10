import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Load environment variables
dotenv.config();
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY;
const isProduction = process.env.NODE_ENV === 'production';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = process.env.PORT || 3000;

// Increase payload limit for image uploads (base64)
app.use(express.json({ limit: '50mb' }));
app.use(cors());

if (!API_KEY) {
  console.error("❌ Critical Error: No API Key found in environment variables.");
  console.error("Please set API_KEY or GEMINI_API_KEY in your .env file.");
}

// Initialize GenAI 
const ai = new GoogleGenAI({ apiKey: API_KEY });

// --- HTTP Endpoints ---

/**
 * POST /api/evaluate
 * Handles evaluation report generation.
 */
app.post('/api/evaluate', async (req, res) => {
  try {
    const { history, images, scenario } = req.body;
    if (!API_KEY) throw new Error("Server missing API Key");

    const transcript = history.map(msg => `${msg.role.toUpperCase()}: ${msg.text}`).join('\n');
    
    const promptText = `
    你是一名专业的销售培训师。请分析以下销售导购（USER）和顾客（MODEL）之间的互动。
    
    场景背景：${scenario.description}
    顾客画像：${scenario.customerPersona}

    我们将提供：
    1. 互动的对话记录（Text）。
    2. 导购在沟通过程中的抓拍照片（Images）。

    对话记录：
    ${transcript}

    **任务要求：**
    请结合对话内容和视觉图像，基于以下维度评估销售导购的表现：

    1. **沟通技巧 (80%)**：
       - **开场与问候**：是否热情？是否建立了良好的第一印象？
       - **需求挖掘**：是否通过提问准确了解了顾客需求？
       - **产品介绍与推荐**：推荐是否合理？产品知识是否准确？是否强调了利益点？
       - **异议处理**：面对顾客的疑虑或拒绝，是否能有效化解？
       - **缔结意识**：是否有尝试推进成交的动作？
    
    2. **非言语/肢体语言 (20%) - 基于提供的图片**：
       - **微笑与亲和力**：导购是否面带微笑？
       - **体态与专注度**：是否有身体前倾（表示倾听）？是否有眼神接触？
       - **专业形象**：整体着装和仪态是否得体？

    **输出要求：**
    请生成一份 JSON 格式的评估报告，包含以下字段：
    - score (0-100): 综合得分。
    - visualAnalysis: 包含视觉得分 (0-100)、微笑检测结果、姿态分析评价、眼神接触评价。
    - summary: 整体评价。
    - strengths: 优势列表。
    - weaknesses: 劣势列表。
    - tips: 具体的改进建议。

    所有输出必须使用中文。
    `;

    const parts = [{ text: promptText }];
    if (images && Array.isArray(images)) {
      images.forEach(base64Data => {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: base64Data } });
      });
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: { role: 'user', parts: parts },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            score: { type: Type.NUMBER },
            visualAnalysis: {
                type: Type.OBJECT,
                properties: {
                    visualScore: { type: Type.NUMBER },
                    smileDetected: { type: Type.BOOLEAN },
                    postureAnalysis: { type: Type.STRING },
                    eyeContactAnalysis: { type: Type.STRING },
                },
                required: ["visualScore", "smileDetected", "postureAnalysis", "eyeContactAnalysis"]
            },
            summary: { type: Type.STRING },
            strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
            weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
            tips: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["score", "visualAnalysis", "summary", "strengths", "weaknesses", "tips"]
        }
      }
    });

    if (response.text) {
      res.json(JSON.parse(response.text));
    } else {
      throw new Error("No text response from model");
    }

  } catch (error) {
    console.error("Evaluation error:", error);
    res.status(500).json({ error: "Evaluation failed", details: error.message });
  }
});


// --- Unified Server Setup ---

const server = http.createServer(app);

// 1. WebSocket Server (Detached mode to allow path filtering)
const wss = new WebSocketServer({ noServer: true });

// WebSocket Logic
wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).substring(7).toUpperCase();
    console.log(`[${clientId}] 🔌 Client Connected via WebSocket (/ws)`);
    
    let session = null;

    ws.on('message', async (rawMsg) => {
        try {
            // Ensure we convert Buffer to string before parsing
            const msgStr = rawMsg.toString();
            const msg = JSON.parse(msgStr);

            if (msg.type === 'start_session') {
                console.log(`[${clientId}] 🚀 Requesting Gemini Live Session...`);
                const { instruction } = msg;
                try {
                    session = await ai.live.connect({
                        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                        config: {
                            responseModalities: [Modality.AUDIO],
                            inputAudioTranscription: {},
                            outputAudioTranscription: {},
                            systemInstruction: instruction
                        },
                        callbacks: {
                            onopen: () => {
                                console.log(`[${clientId}] ✅ Gemini Session Established`);
                                ws.send(JSON.stringify({ type: 'status', status: 'open' }));
                            },
                            onmessage: (serverContent) => {
                                // --- LOGGING LOGIC START ---
                                const content = serverContent.serverContent;
                                if (content) {
                                    // 1. Log User Speech (Transcription)
                                    if (content.inputTranscription?.text) {
                                        console.log(`[${clientId}] 🎤 User: "${content.inputTranscription.text}"`);
                                    }
                                    
                                    // 2. Log AI Speech (Transcription)
                                    if (content.outputTranscription?.text) {
                                        console.log(`[${clientId}] 🤖 AI: "${content.outputTranscription.text}"`);
                                    }

                                    // 3. Log Audio Output (Briefly)
                                    if (content.modelTurn?.parts?.[0]?.inlineData) {
                                        process.stdout.write(`[${clientId}] 🔊 <AudioChunk> \r`); 
                                    }

                                    // 4. Log Interruptions
                                    if (content.interrupted) {
                                        console.log(`\n[${clientId}] ⚠️ Interrupted`);
                                    }
                                }
                                // --- LOGGING LOGIC END ---

                                // IMPORTANT: pass the WHOLE server message structure
                                ws.send(JSON.stringify({ type: 'gemini', data: serverContent }));
                            },
                            onclose: () => {
                                console.log(`[${clientId}] 🔒 Gemini Session Closed by Remote`);
                                ws.send(JSON.stringify({ type: 'status', status: 'closed' }));
                            },
                            onerror: (e) => {
                                console.error(`[${clientId}] ❌ Gemini Session Error:`, e);
                                ws.send(JSON.stringify({ type: 'error', message: "Gemini API Error: " + e.message }));
                            }
                        }
                    });
                } catch (e) {
                    console.error(`[${clientId}] ❌ Gemini Connection Failed:`, e);
                    ws.send(JSON.stringify({ type: 'error', message: e.message }));
                }
            } else if (msg.type === 'input') {
                if (session) {
                    const mimeType = msg.payload?.media?.mimeType;
                    // Verbose logging for non-audio inputs (images) to reduce noise
                    if (mimeType && mimeType.includes('image')) {
                         console.log(`[${clientId}] 📤 Sending Video Frame (${Math.round(msg.payload.media.data.length/1024)}KB)`);
                    }
                    session.sendRealtimeInput(msg.payload);
                } else {
                    // Silent fail for keep-alives or pre-connection data
                }
            }
        } catch (err) {
            console.error(`[${clientId}] ❌ Error processing WebSocket message:`, err);
        }
    });

    ws.on('error', (err) => {
        console.error(`[${clientId}] ❌ WebSocket Client Error:`, err);
    });

    ws.on('close', () => {
        console.log(`[${clientId}] 🔌 Client Disconnected`);
        if (session) {
            session = null;
        }
    });
});

// Handle Upgrade Manually to separate /ws from Vite's HMR
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    // Let Vite/Express handle other upgrades (crucial for HMR)
    // No action needed, just don't destroy socket
  }
});

// 2. Frontend Serving Logic (Vite Middleware or Static)

async function setupServer() {
  if (!isProduction) {
    // Development: Use Vite as middleware
    console.log("🚀 Starting in Development Mode (Vite Middleware)");
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa', // Handle SPA fallbacks
    });
    app.use(vite.middlewares);
  } else {
    // Production: Serve static files from /dist
    console.log("📦 Starting in Production Mode (Static Files)");
    const distPath = path.resolve(__dirname, '../dist');
    if (fs.existsSync(distPath)) {
        app.use(express.static(distPath));
        // Fallback for SPA routing
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    } else {
        console.error("❌ 'dist' directory not found. Did you run 'npm run build'?");
    }
  }

  // Bind to 0.0.0.0 to listen on all interfaces
  server.listen(port, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`✅ Server running at http://0.0.0.0:${port}`);
    console.log(`==================================================\n`);
  });
}

setupServer();