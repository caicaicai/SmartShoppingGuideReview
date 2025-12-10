import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { WebSocketServer } from 'ws';
import http from 'http';

// Load environment variables
dotenv.config();
const API_KEY = process.env.API_KEY || process.env.GEMINI_API_KEY;

const app = express();
const port = 3000;

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

// --- WebSocket Relay Server ---

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws) => {
  console.log('Client connected to WebSocket Relay');
  
  if (!API_KEY) {
    ws.close(1008, "API Key missing on server");
    return;
  }

  let liveSession = null;

  try {
    // 1. Initialize Gemini Live Session on the SERVER
    liveSession = await ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-09-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {
          console.log('Gemini Live API Connected');
          ws.send(JSON.stringify({ type: 'status', message: 'connected' }));
        },
        onmessage: (msg) => {
          // Forward Gemini messages to Frontend
          ws.send(JSON.stringify({ type: 'gemini_message', content: msg }));
        },
        onclose: () => {
          console.log('Gemini Live API Closed');
          ws.close();
        },
        onerror: (err) => {
          console.error('Gemini Live API Error:', err);
          ws.send(JSON.stringify({ type: 'error', message: 'AI Service Error' }));
        }
      }
    });

    // 2. Handle Messages from Frontend
    ws.on('message', async (data) => {
      try {
        const parsed = JSON.parse(data);
        
        if (parsed.type === 'config') {
             // Allow frontend to set system instructions via the relay
             // Note: In a real app, you might validate this or hardcode it on server for safety
             // But passing scenario data is fine.
             // However, `live.connect` config is immutable after connection usually, 
             // but we can send tool responses or content updates.
             // For simplicity, we assume session is established.
        } else if (parsed.type === 'audio') {
            // Forward Audio Chunk
            await liveSession.sendRealtimeInput({
                media: {
                    mimeType: 'audio/pcm;rate=16000',
                    data: parsed.data // base64
                }
            });
        } else if (parsed.type === 'image') {
             // Forward Image Chunk
             await liveSession.sendRealtimeInput({
                media: {
                    mimeType: 'image/jpeg',
                    data: parsed.data // base64
                }
            });
        } else if (parsed.type === 'setup') {
           // Wait, we need to send the system instruction?
           // The SDK `connect` takes config.
           // Since we already connected, we can't change systemInstruction easily without reconnection.
           // IMPROVEMENT: We should wait for frontend 'setup' message BEFORE connecting to Gemini.
        }
      } catch (e) {
        console.error("Error processing frontend message:", e);
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected');
      if (liveSession) {
          // There isn't an explicit close method on the session object exposed by connect's promise result directly
          // in some versions, but the connection drops when the object is GC'd or we can rely on timeout.
          // Ideally, we close the stream if we had access to the underlying socket.
      }
    });

  } catch (err) {
    console.error("Failed to connect to Gemini:", err);
    ws.close(1011, "Failed to connect to AI Service");
  }
});

// Handling the specific case where we need the system instruction DYNAMICALLY based on frontend scenario
// We need to refactor the connection logic to wait for the frontend to say "Start this scenario".

// Let's replace the wss.on('connection') logic with a delayed connection approach.
wss.removeAllListeners('connection');

wss.on('connection', (ws) => {
    let session = null;

    ws.on('message', async (rawMsg) => {
        const msg = JSON.parse(rawMsg);

        if (msg.type === 'start_session') {
            // Frontend sends the scenario details, THEN we connect to Gemini
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
                        onopen: () => ws.send(JSON.stringify({ type: 'status', status: 'open' })),
                        onmessage: (serverContent) => ws.send(JSON.stringify({ type: 'gemini', data: serverContent })),
                        onclose: () => ws.send(JSON.stringify({ type: 'status', status: 'closed' })),
                        onerror: (e) => console.error(e)
                    }
                });
            } catch (e) {
                console.error("Gemini connection failed", e);
                ws.send(JSON.stringify({ type: 'error', message: e.message }));
            }
        } else if (msg.type === 'input') {
            if (session) {
                session.sendRealtimeInput(msg.payload);
            }
        }
    });

    ws.on('close', () => {
        // Cleanup if needed
    });
});


server.listen(port, () => {
  console.log(`Backend server running at http://localhost:${port}`);
  console.log(`Secure mode: WebSockets proxying to Gemini Live API.`);
});