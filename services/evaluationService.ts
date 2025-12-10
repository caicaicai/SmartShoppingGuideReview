import { GoogleGenAI, Type } from "@google/genai";
import { ChatMessage, EvaluationReport, Scenario } from '../types';

export async function generateEvaluation(history: ChatMessage[], images: string[], scenario: Scenario): Promise<EvaluationReport> {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
      console.error("API Key missing during evaluation");
      return {
          score: 0,
          visualAnalysis: {
              visualScore: 0,
              smileDetected: false,
              postureAnalysis: "无法分析",
              eyeContactAnalysis: "无法分析"
          },
          summary: "错误：未找到 API Key。请检查 .env 配置文件。",
          strengths: [],
          weaknesses: [],
          tips: ["请在本地根目录配置 .env 文件。"]
      };
  }
    
  const ai = new GoogleGenAI({ apiKey });
  
  const transcript = history.map(msg => `${msg.role.toUpperCase()}: ${msg.text}`).join('\n');

  // Build the parts array: Text Prompt + Image Data
  const parts: any[] = [];
  
  // 1. Text Prompt
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
  parts.push({ text: promptText });

  // 2. Append Images (Max 10 distinct frames)
  // We attach them as inline data
  images.forEach(base64Data => {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: base64Data
      }
    });
  });

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: {
        role: 'user',
        parts: parts
      },
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
      return JSON.parse(response.text) as EvaluationReport;
    }
    throw new Error("Empty response");
  } catch (error) {
    console.error("Evaluation failed", error);
    return {
      score: 0,
      visualAnalysis: {
          visualScore: 0,
          smileDetected: false,
          postureAnalysis: "无法分析",
          eyeContactAnalysis: "无法分析"
      },
      summary: "由于技术错误，生成报告失败。",
      strengths: [],
      weaknesses: [],
      tips: ["请重试。"]
    };
  }
}