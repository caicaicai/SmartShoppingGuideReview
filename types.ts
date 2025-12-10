export enum AppState {
  IDLE = 'IDLE',
  SETUP = 'SETUP',
  SESSION = 'SESSION',
  REPORT = 'REPORT'
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  customerPersona: string;
  difficulty: '简单' | '中等' | '困难';
  avatarUrl: string;
  videoUrl?: string;
  initialPrompt: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export interface VisualAnalysis {
  visualScore: number;
  smileDetected: boolean;
  postureAnalysis: string;
  eyeContactAnalysis: string;
}

export interface EvaluationReport {
  score: number;
  visualAnalysis: VisualAnalysis; // New field
  summary: string;
  strengths: string[];
  weaknesses: string[];
  tips: string[];
}