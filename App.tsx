import React, { useState } from 'react';
import { AppState, Scenario, ChatMessage, EvaluationReport } from './types';
import { SCENARIOS } from './constants';
import LiveSession from './components/LiveSession';
import { generateEvaluation } from './services/evaluationService';

// Simple Icons
const RobotIcon = () => (
  <svg className="w-12 h-12 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
  </svg>
);

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);

  const startScenario = (scenario: Scenario) => {
    setSelectedScenario(scenario);
    setAppState(AppState.SESSION);
  };

  const handleSessionEnd = async (sessionHistory: ChatMessage[], sessionImages: string[]) => {
    setHistory(sessionHistory);
    setAppState(AppState.REPORT);
    setIsGeneratingReport(true);
    
    if (selectedScenario) {
      const result = await generateEvaluation(sessionHistory, sessionImages, selectedScenario);
      setReport(result);
      setIsGeneratingReport(false);
    }
  };

  const resetApp = () => {
    setAppState(AppState.IDLE);
    setHistory([]);
    setReport(null);
    setSelectedScenario(null);
  };

  // --- Render Views ---

  // 1. Landing / IDLE
  if (appState === AppState.IDLE) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
        <div className="max-w-4xl w-full text-center space-y-8">
          <div className="flex justify-center mb-6">
            <div className="bg-white p-6 rounded-full shadow-xl">
              <RobotIcon />
            </div>
          </div>
          <h1 className="text-5xl font-extrabold text-gray-900 tracking-tight">智能导购评测系统</h1>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            提升您的零售服务水平。与 AI 驱动的顾客进行实战演练，获得实时互动反馈，并为您的销售技巧获取专业认证。
          </p>
          
          <div className="mt-12">
            <button 
              onClick={() => setAppState(AppState.SETUP)}
              className="bg-blue-600 hover:bg-blue-700 text-white text-lg font-bold py-4 px-10 rounded-lg shadow-lg transition transform hover:-translate-y-1 hover:shadow-2xl"
            >
              开始新的评测
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 2. Setup / Scenario Selection
  if (appState === AppState.SETUP) {
    return (
      <div className="min-h-screen bg-gray-100 p-8">
        <div className="max-w-6xl mx-auto">
          <button onClick={() => setAppState(AppState.IDLE)} className="text-gray-500 hover:text-gray-900 mb-8 font-medium">← 返回首页</button>
          <h2 className="text-3xl font-bold text-gray-900 mb-2">选择培训场景</h2>
          <p className="text-gray-600 mb-8">选择一个顾客画像来练习您的销售话术。</p>
          
          <div className="grid md:grid-cols-3 gap-6">
            {SCENARIOS.map(scenario => (
              <div key={scenario.id} className="bg-white rounded-xl shadow-md overflow-hidden hover:shadow-xl transition-shadow border border-gray-100 flex flex-col">
                <div className="h-48 overflow-hidden bg-gray-200 relative">
                  <img src={scenario.avatarUrl} alt={scenario.title} className="w-full h-full object-cover" />
                  <div className="absolute top-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                    {scenario.difficulty}
                  </div>
                </div>
                <div className="p-6 flex-1 flex flex-col">
                  <h3 className="text-xl font-bold text-gray-800 mb-2">{scenario.title}</h3>
                  <p className="text-gray-600 text-sm mb-4 flex-1">{scenario.description}</p>
                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">顾客画像</p>
                    <p className="text-sm text-blue-600 italic">"{scenario.customerPersona}"</p>
                  </div>
                  <button 
                    onClick={() => startScenario(scenario)}
                    className="mt-6 w-full bg-gray-900 hover:bg-gray-800 text-white font-bold py-3 rounded-lg transition-colors"
                  >
                    开始模拟
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // 3. Active Session
  if (appState === AppState.SESSION && selectedScenario) {
    return (
      <LiveSession 
        scenario={selectedScenario} 
        onEndSession={handleSessionEnd} 
      />
    );
  }

  // 4. Report / Loading Report
  if (appState === AppState.REPORT) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-5xl mx-auto bg-white rounded-2xl shadow-2xl overflow-hidden min-h-[600px] flex flex-col">
          {/* Header */}
          <div className="bg-blue-600 p-8 text-white">
            <h2 className="text-3xl font-bold">评估报告</h2>
            <p className="opacity-80 mt-2">场景: {selectedScenario?.title}</p>
          </div>

          <div className="flex-1 p-8">
            {isGeneratingReport ? (
              <div className="h-full flex flex-col items-center justify-center space-y-6">
                <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-blue-600"></div>
                <div className="text-center">
                  <h3 className="text-xl font-semibold text-gray-800">正在进行多模态分析...</h3>
                  <p className="text-gray-500 mt-2">AI 正在分析您的对话逻辑以及肢体语言（微笑、体态等）。</p>
                </div>
              </div>
            ) : report ? (
              <div className="space-y-8 animate-fade-in">
                {/* Top Score Section */}
                <div className="flex flex-col md:flex-row items-center gap-8 border-b border-gray-100 pb-8">
                  <div className={`
                    w-32 h-32 rounded-full flex flex-col items-center justify-center text-white shadow-lg shrink-0
                    ${report.score >= 80 ? 'bg-gradient-to-br from-green-400 to-green-600' : report.score >= 60 ? 'bg-gradient-to-br from-yellow-400 to-yellow-600' : 'bg-gradient-to-br from-red-400 to-red-600'}
                  `}>
                    <span className="text-4xl font-bold">{report.score}</span>
                    <span className="text-xs opacity-80 uppercase font-semibold">综合得分</span>
                  </div>
                  <div className="flex-1 text-center md:text-left">
                    <h3 className="text-2xl font-bold text-gray-800 mb-2">整体评价</h3>
                    <p className="text-gray-600 text-lg leading-relaxed">{report.summary}</p>
                  </div>
                </div>

                {/* Visual Analysis Section (New) */}
                <div className="bg-purple-50 rounded-2xl p-6 border border-purple-100">
                    <h4 className="flex items-center text-purple-900 font-bold text-xl mb-6">
                      <svg className="w-6 h-6 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                      视觉/肢体语言表现
                    </h4>
                    <div className="grid md:grid-cols-3 gap-6">
                        {/* Visual Score */}
                        <div className="bg-white p-4 rounded-xl shadow-sm text-center">
                            <div className="text-gray-500 text-sm mb-1 uppercase font-bold tracking-wider">形象仪表</div>
                            <div className="text-3xl font-bold text-purple-600">{report.visualAnalysis.visualScore}<span className="text-lg text-gray-400">/100</span></div>
                        </div>
                         {/* Smile */}
                        <div className="bg-white p-4 rounded-xl shadow-sm flex flex-col items-center justify-center">
                            <div className="text-gray-500 text-sm mb-2 uppercase font-bold tracking-wider">微笑检测</div>
                             {report.visualAnalysis.smileDetected ? (
                                 <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-bold">😊 微笑在线</span>
                             ) : (
                                 <span className="px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-sm font-bold">😐 表情严肃</span>
                             )}
                        </div>
                        {/* Posture Text */}
                        <div className="bg-white p-4 rounded-xl shadow-sm md:col-span-1">
                             <div className="text-gray-500 text-sm mb-2 uppercase font-bold tracking-wider">体态与眼神</div>
                             <p className="text-sm text-gray-700">{report.visualAnalysis.postureAnalysis}</p>
                             <p className="text-sm text-gray-500 mt-1">{report.visualAnalysis.eyeContactAnalysis}</p>
                        </div>
                    </div>
                </div>

                {/* Grid for Strengths/Weaknesses */}
                <div className="grid md:grid-cols-2 gap-8">
                  <div className="bg-green-50 p-6 rounded-xl border border-green-100">
                    <h4 className="flex items-center text-green-800 font-bold text-lg mb-4">
                      <span className="mr-2">👍</span> 优势
                    </h4>
                    <ul className="space-y-3">
                      {report.strengths.map((s, i) => (
                        <li key={i} className="flex items-start text-green-700 text-sm bg-white/50 p-2 rounded">
                          <span className="mr-2 text-green-500 font-bold">•</span> {s}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="bg-red-50 p-6 rounded-xl border border-red-100">
                    <h4 className="flex items-center text-red-800 font-bold text-lg mb-4">
                      <span className="mr-2">⚠️</span> 待改进领域
                    </h4>
                    <ul className="space-y-3">
                      {report.weaknesses.map((w, i) => (
                        <li key={i} className="flex items-start text-red-700 text-sm bg-white/50 p-2 rounded">
                          <span className="mr-2 text-red-500 font-bold">•</span> {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Coach Tips */}
                <div className="bg-blue-50 p-6 rounded-xl border border-blue-100">
                   <h4 className="flex items-center text-blue-800 font-bold text-lg mb-4">
                      <span className="mr-2">💡</span> 专家辅导建议
                    </h4>
                    <ul className="grid md:grid-cols-2 gap-4">
                       {report.tips.map((tip, i) => (
                        <li key={i} className="bg-white p-4 rounded-lg shadow-sm text-blue-900 text-sm border-l-4 border-blue-400">
                          {tip}
                        </li>
                       ))}
                    </ul>
                </div>
                
                <div className="flex justify-end pt-4 pb-8">
                    <button 
                        onClick={resetApp}
                        className="bg-gray-900 hover:bg-gray-800 text-white font-bold py-3 px-8 rounded-lg shadow-lg transform transition hover:-translate-y-1"
                    >
                        完成并返回首页
                    </button>
                </div>
              </div>
            ) : (
              <div className="text-red-500 flex flex-col items-center justify-center h-full">
                  <p className="text-xl font-bold mb-2">生成报告失败</p>
                  <button onClick={resetApp} className="text-blue-600 underline">返回重试</button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
};

export default App;