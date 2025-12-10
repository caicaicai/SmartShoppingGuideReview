import { ChatMessage, EvaluationReport, Scenario } from '../types';

export async function generateEvaluation(history: ChatMessage[], images: string[], scenario: Scenario): Promise<EvaluationReport> {
  try {
    const response = await fetch('/api/evaluate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        history,
        images,
        scenario
      }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.statusText}`);
    }

    const data = await response.json();
    return data as EvaluationReport;

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
      summary: "连接服务器失败，无法生成报告。",
      strengths: [],
      weaknesses: [],
      tips: ["请确保后台服务(npm run server)已启动。"]
    };
  }
}