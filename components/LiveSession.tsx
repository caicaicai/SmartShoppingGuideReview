import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChatMessage, Scenario } from '../types';
import { createPcmBlob, decodeAudioData, base64ToUint8Array, downsampleBuffer } from '../utils/audioUtils';
import { SYSTEM_INSTRUCTION_TEMPLATE } from '../constants';

interface LiveSessionProps {
  scenario: Scenario;
  onEndSession: (history: ChatMessage[], images: string[]) => void;
}

const FRAME_RATE = 5; // Frames per second sent to model
const EVAL_IMAGE_INTERVAL = 3000; // Capture an image for evaluation every 3 seconds
const MAX_EVAL_IMAGES = 10; // Max images to send to evaluation to avoid payload limits
const JPEG_QUALITY = 0.6;

const LiveSession: React.FC<LiveSessionProps> = ({ scenario, onEndSession }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [transcripts, setTranscripts] = useState<ChatMessage[]>([]);
  // Streaming state for real-time subtitle effect
  const [streamingUserText, setStreamingUserText] = useState('');
  const [streamingModelText, setStreamingModelText] = useState('');
  
  const [error, setError] = useState<string | null>(null);
  const [micActive, setMicActive] = useState(true);
  const [videoError, setVideoError] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [hasStarted, setHasStarted] = useState(false); // User gesture check

  // Refs for audio/video handling
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  // IMPORTANT: Keep processor in ref to prevent Garbage Collection
  const processorRef = useRef<ScriptProcessorNode | null>(null); 
  
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const frameIntervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Store images for final evaluation
  const evalImagesRef = useRef<string[]>([]);
  const lastEvalImageTimeRef = useRef<number>(0);

  // Buffer for transcript assembly (Backing source for final commit)
  const currentInputTransRef = useRef('');
  const currentOutputTransRef = useRef('');

  // Reset video error when scenario changes
  useEffect(() => {
    setVideoError(false);
  }, [scenario.id]);

  const ensureAudioContext = async () => {
    if (outputAudioContextRef.current && outputAudioContextRef.current.state === 'suspended') {
        console.log("🔊 Resuming Output Audio Context");
        await outputAudioContextRef.current.resume();
    }
    if (inputAudioContextRef.current && inputAudioContextRef.current.state === 'suspended') {
        console.log("🎤 Resuming Input Audio Context");
        await inputAudioContextRef.current.resume();
    }
  };

  const startSession = async () => {
    setHasStarted(true);
    setInitializing(true);
    await initializeSession();
  };

  const initializeSession = useCallback(async () => {
    setError(null);

    try {
      console.log("🎬 Initializing Live Session...");
      
      // 1. Setup Media Stream (Camera + Mic)
      // CRITICAL: Echo Cancellation is required to prevent the model from hearing itself
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000, 
          echoCancellation: true, 
          noiseSuppression: true,
          autoGainControl: true
        },
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true; // Prevent local echo
        videoRef.current.play();
      }

      // 2. Setup Audio Contexts
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      console.log(`🎤 Input Sample Rate: ${inputCtx.sampleRate}`);
      
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;
      
      await ensureAudioContext();

      // 3. Connect to Backend WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host; // includes hostname and port
      // IMPORTANT: Use /ws to avoid conflict with Vite HMR
      const wsUrl = `${protocol}//${host}/ws`; 
      
      console.log(`🔌 Connecting to WebSocket at ${wsUrl}`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("✅ WebSocket Connected");
        const instruction = SYSTEM_INSTRUCTION_TEMPLATE
            .replace('${persona}', scenario.customerPersona)
            .replace('${initialPrompt}', scenario.initialPrompt);
        
        ws.send(JSON.stringify({
            type: 'start_session',
            instruction: instruction
        }));
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'status' && msg.status === 'open') {
             console.log("🟢 AI Session Ready - Starting Streams");
             setIsConnected(true);
             setInitializing(false);
             startAudioCapture(inputCtx, stream, ws);
             startVideoStreaming(ws);
        } else if (msg.type === 'gemini') {
             handleServerMessage(msg.data, outputCtx);
        } else if (msg.type === 'error') {
             console.error("❌ Server reported error:", msg.message);
             setError(`服务器错误: ${msg.message}`);
             setInitializing(false);
        }
      };

      ws.onerror = (e) => {
        console.error("❌ WebSocket error", e);
      };
      
      ws.onclose = (e) => {
        console.log(`🔒 WebSocket closed (Code: ${e.code})`);
        setIsConnected(false);
      };

    } catch (err: any) {
      console.error("❌ Initialization failed:", err);
      setError(err.message || "初始化失败，请检查设备权限或网络。");
      setInitializing(false);
    }
  }, [scenario]);

  const startAudioCapture = (ctx: AudioContext, stream: MediaStream, ws: WebSocket) => {
    console.log("🎤 Starting Audio Capture Chain");
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor; // Prevent GC
    
    processor.onaudioprocess = async (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      
      // Downsample to 16000Hz if necessary
      const resampledData = downsampleBuffer(inputData, ctx.sampleRate, 16000);
      const pcmGenAiContent = createPcmBlob(resampledData);
      
      if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
              type: 'input',
              payload: {
                  media: {
                      mimeType: 'audio/pcm;rate=16000',
                      data: pcmGenAiContent.data 
                  }
              }
          }));
      }
    };
    
    source.connect(processor);
    processor.connect(ctx.destination);
  };

  const startVideoStreaming = (ws: WebSocket) => {
    console.log("📹 Starting Video Streaming");
    
    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);

    frameIntervalRef.current = window.setInterval(() => {
        if (!videoRef.current || !canvasRef.current) return;
        
        const video = videoRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        
        if (!ctx) return;
        
        if (video.readyState >= 2) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            
            const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
            const base64Data = dataUrl.split(',')[1];
            
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'input',
                    payload: {
                        media: {
                            mimeType: 'image/jpeg',
                            data: base64Data
                        }
                    }
                }));
            }

            const now = Date.now();
            if (now - lastEvalImageTimeRef.current >= EVAL_IMAGE_INTERVAL && evalImagesRef.current.length < MAX_EVAL_IMAGES) {
                evalImagesRef.current.push(base64Data);
                lastEvalImageTimeRef.current = now;
            }
        }
    }, 1000 / FRAME_RATE);
  };

  const handleServerMessage = async (message: any, ctx: AudioContext) => {
    // Ensure context is running when we receive data
    if (ctx.state === 'suspended') {
        await ctx.resume();
    }

    const serverContent = message.serverContent;
    if (!serverContent) return;

    // 1. Audio Playback
    const audioData = serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData) {
        try {
            const audioBuffer = await decodeAudioData(
                base64ToUint8Array(audioData),
                ctx,
                24000
            );
        
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            
            const currentTime = ctx.currentTime;
            const startTime = Math.max(nextStartTimeRef.current, currentTime);
            source.start(startTime);
            nextStartTimeRef.current = startTime + audioBuffer.duration;
            
            sourcesRef.current.add(source);
            source.onended = () => sourcesRef.current.delete(source);
        } catch (e) {
            console.error("Error decoding audio:", e);
        }
    }

    // 2. Transcription (Stream Accumulation)
    if (serverContent?.outputTranscription?.text) {
        const text = serverContent.outputTranscription.text;
        currentOutputTransRef.current += text;
        setStreamingModelText(prev => prev + text);
    }
    if (serverContent?.inputTranscription?.text) {
        const text = serverContent.inputTranscription.text;
        currentInputTransRef.current += text;
        setStreamingUserText(prev => prev + text);
    }

    // 3. Turn Complete (Commit)
    if (serverContent?.turnComplete) {
        if (currentInputTransRef.current.trim()) {
            setTranscripts(prev => [...prev, { role: 'user', text: currentInputTransRef.current, timestamp: Date.now() }]);
            currentInputTransRef.current = '';
            setStreamingUserText('');
        }
        if (currentOutputTransRef.current.trim()) {
            setTranscripts(prev => [...prev, { role: 'model', text: currentOutputTransRef.current, timestamp: Date.now() }]);
            currentOutputTransRef.current = '';
            setStreamingModelText('');
        }
    }

    if (serverContent?.interrupted) {
        console.log("⚠️ Interrupted");
        // Only stop currently playing sources, do not reset future timeline aggressively
        sourcesRef.current.forEach(s => s.stop());
        sourcesRef.current.clear();
        
        // FIX: Commit partial transcript so it doesn't disappear when interrupted
        if (currentOutputTransRef.current.trim()) {
            setTranscripts(prev => [...prev, { 
                role: 'model', 
                text: currentOutputTransRef.current + " (被打断)", 
                timestamp: Date.now() 
            }]);
        }
        
        // Reset buffers
        nextStartTimeRef.current = ctx.currentTime;
        currentOutputTransRef.current = '';
        setStreamingModelText('');
    }
  };

  const endSession = async () => {
    const finalHistory = [...transcripts];
    // Push pending text if exists
    if (currentInputTransRef.current) finalHistory.push({ role: 'user', text: currentInputTransRef.current, timestamp: Date.now() });
    if (currentOutputTransRef.current) finalHistory.push({ role: 'model', text: currentOutputTransRef.current, timestamp: Date.now() });

    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
    if (wsRef.current) wsRef.current.close();
    
    // Cleanup Processor
    if (processorRef.current) {
        processorRef.current.disconnect();
        processorRef.current = null;
    }

    if (inputAudioContextRef.current) inputAudioContextRef.current.close();
    if (outputAudioContextRef.current) outputAudioContextRef.current.close();
    
    onEndSession(finalHistory, evalImagesRef.current);
  };

  useEffect(() => {
    // Do NOT auto initialize. Wait for user gesture.
    return () => {
        if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
        if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
        if (wsRef.current) wsRef.current.close();
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
        }
        
        if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') inputAudioContextRef.current.close();
        if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') outputAudioContextRef.current.close();
    };
  }, []);

  const chatEndRef = useRef<HTMLDivElement>(null);
  // Auto-scroll on transcript OR streaming text update
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts, streamingUserText, streamingModelText]);

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white overflow-hidden">
        {/* Header */}
        <div className="flex justify-between items-center p-4 bg-gray-800 border-b border-gray-700">
            <div>
                <h2 className="text-xl font-bold text-blue-400">实时评估 (一体化服务)</h2>
                <p className="text-sm text-gray-400">场景: {scenario.title}</p>
            </div>
            <button 
                onClick={endSession}
                className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-full font-bold transition-colors"
            >
                结束评估
            </button>
        </div>

        {/* Start Overlay - Critical for Audio Context */}
        {!hasStarted && (
            <div className="absolute inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-6 text-center">
                <h3 className="text-3xl font-bold mb-4">准备开始评估</h3>
                <p className="mb-8 text-gray-300 max-w-md">我们将请求您的麦克风和摄像头权限。请确保环境安静，并尽量使用耳机以获得最佳体验。</p>
                <button 
                    onClick={startSession}
                    className="bg-green-600 hover:bg-green-700 text-white text-xl font-bold py-4 px-12 rounded-full shadow-lg transform transition hover:scale-105"
                >
                    点击开始
                </button>
            </div>
        )}

        {/* Main Split View */}
        <div className="flex flex-1 overflow-hidden relative">
            
            {/* Left: AI Customer View */}
            <div className="w-1/2 relative bg-black border-r border-gray-800 overflow-hidden">
                {scenario.videoUrl && !videoError ? (
                    <video 
                        src={scenario.videoUrl} 
                        className={`w-full h-full object-cover transition-opacity duration-1000 ${isConnected ? 'opacity-100' : 'opacity-60 grayscale'}`}
                        autoPlay 
                        loop 
                        muted 
                        playsInline
                        poster={scenario.avatarUrl}
                        onError={() => {
                            setVideoError(true);
                        }}
                    />
                ) : (
                    <img 
                        src={scenario.avatarUrl} 
                        className={`w-full h-full object-cover transition-opacity ${isConnected ? 'opacity-100' : 'opacity-50'}`}
                        alt="Customer Avatar"
                    />
                )}
                
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black via-black/60 to-transparent p-6 pt-12 text-center pointer-events-none">
                    <p className="text-blue-400 font-bold tracking-widest text-xs mb-1 uppercase">AI 顾客</p>
                    <h3 className="text-2xl font-light text-white mb-2">{scenario.customerPersona.split('，')[0]}</h3>
                    
                    {initializing && !error && (
                        <div className="flex items-center justify-center gap-2 text-blue-400">
                            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
                            <span className="text-sm">正在连接服务...</span>
                        </div>
                    )}
                    
                    {isConnected && (
                         <div className="flex items-center justify-center gap-2 text-green-400">
                            <div className="w-2 h-2 bg-green-400 rounded-full animate-ping"></div>
                            <span className="text-sm">在线</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Right: User Camera View */}
            <div className="w-1/2 bg-black relative">
                <video 
                    ref={videoRef} 
                    className="w-full h-full object-cover transform -scale-x-100" 
                    playsInline 
                    autoPlay 
                    muted 
                />
                <canvas ref={canvasRef} className="hidden" />
                
                <div className="absolute bottom-6 left-0 right-0 flex justify-center gap-4">
                     <button 
                        onClick={(e) => { e.stopPropagation(); setMicActive(!micActive); }}
                        className={`p-4 rounded-full ${micActive ? 'bg-gray-700 hover:bg-gray-600' : 'bg-red-600 hover:bg-red-700'} text-white transition-colors shadow-lg border border-white/10`}
                     >
                        {micActive ? (
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                        ) : (
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" stroke="#fff"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg>
                        )}
                     </button>
                </div>
            </div>

            {/* Transcription Overlay */}
            <div className="absolute top-4 right-4 w-80 bg-black/60 backdrop-blur-md rounded-xl p-4 border border-white/10 max-h-[40%] overflow-y-auto scrollbar-hide shadow-xl">
                 <h3 className="text-xs font-bold text-gray-400 uppercase mb-2">实时对话字幕</h3>
                 <div className="space-y-3">
                    {transcripts.map((t, idx) => (
                        <div key={idx} className={`text-sm ${t.role === 'user' ? 'text-green-300' : 'text-blue-300'}`}>
                            <span className="font-bold opacity-75">{t.role === 'user' ? '导购' : '顾客'}:</span> {t.text}
                        </div>
                    ))}
                    {/* Render Streaming Text (Pending) */}
                    {streamingUserText && (
                        <div className="text-sm text-green-300 opacity-80 animate-pulse">
                            <span className="font-bold">导购:</span> {streamingUserText}...
                        </div>
                    )}
                    {streamingModelText && (
                        <div className="text-sm text-blue-300 opacity-80 animate-pulse">
                            <span className="font-bold">顾客:</span> {streamingModelText}...
                        </div>
                    )}
                    <div ref={chatEndRef} />
                 </div>
            </div>

            {/* Error Toast */}
            {error && (
                <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-red-600/90 text-white px-8 py-6 rounded-xl shadow-2xl backdrop-blur max-w-lg text-center border border-red-400">
                    <h3 className="text-xl font-bold mb-2">连接中断</h3>
                    <p className="text-red-100 mb-4">{error}</p>
                    <button onClick={() => window.location.reload()} className="bg-white text-red-600 px-4 py-2 rounded-lg font-bold text-sm hover:bg-gray-100">刷新重试</button>
                </div>
            )}
        </div>
    </div>
  );
};

export default LiveSession;