import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ChatMessage, Scenario } from '../types';
import { createPcmBlob, decodeAudioData, base64ToUint8Array } from '../utils/audioUtils';
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
  const [error, setError] = useState<string | null>(null);
  const [micActive, setMicActive] = useState(true);
  const [videoError, setVideoError] = useState(false);

  // Refs for audio/video handling
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const frameIntervalRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Store images for final evaluation
  const evalImagesRef = useRef<string[]>([]);
  const lastEvalImageTimeRef = useRef<number>(0);

  // Buffer for transcript assembly
  const currentInputTransRef = useRef('');
  const currentOutputTransRef = useRef('');

  // Reset video error when scenario changes
  useEffect(() => {
    setVideoError(false);
  }, [scenario.id]);

  const initializeSession = useCallback(async () => {
    try {
      // 1. Setup Media Stream (Camera + Mic)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
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
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const config = {
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        systemInstruction: SYSTEM_INSTRUCTION_TEMPLATE
          .replace('${persona}', scenario.customerPersona)
          .replace('${initialPrompt}', scenario.initialPrompt),
      };

      // 3. Connect to Live API
      const sessionPromise = ai.live.connect({
        model: config.model,
        config: {
          systemInstruction: config.systemInstruction,
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {}, 
          outputAudioTranscription: {}, 
        },
        callbacks: {
          onopen: () => {
            console.log("Session opened");
            setIsConnected(true);
            
            // Start Audio Streaming
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
              if (!micActive) return; // Simple mute logic
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            
            source.connect(processor);
            processor.connect(inputCtx.destination);

            // Start Video Streaming
            startVideoStreaming(sessionPromise);
          },
          onmessage: async (msg: LiveServerMessage) => {
            handleServerMessage(msg, outputCtx);
          },
          onclose: () => {
            console.log("Session closed");
            setIsConnected(false);
          },
          onerror: (err) => {
            console.error("Session error:", err);
            setError("连接错误，请重试。");
          }
        }
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (err) {
      console.error("Initialization failed:", err);
      setError("无法访问摄像头/麦克风或连接 AI 服务失败。");
    }
  }, [scenario, micActive]);

  const startVideoStreaming = (sessionPromise: Promise<any>) => {
    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);

    frameIntervalRef.current = window.setInterval(() => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = video.videoWidth * 0.5; // Scale down for bandwidth
      canvas.height = video.videoHeight * 0.5;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const base64 = canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
      
      // 1. Send to Live API
      sessionPromise.then(session => {
        session.sendRealtimeInput({
          media: {
            mimeType: 'image/jpeg',
            data: base64
          }
        });
      });

      // 2. Capture for Evaluation (Sampled)
      const now = Date.now();
      if (now - lastEvalImageTimeRef.current > EVAL_IMAGE_INTERVAL) {
        lastEvalImageTimeRef.current = now;
        evalImagesRef.current.push(base64);
        // Keep only the last N images to manage memory/context size
        if (evalImagesRef.current.length > MAX_EVAL_IMAGES) {
            evalImagesRef.current.shift();
        }
      }

    }, 1000 / FRAME_RATE);
  };

  const handleServerMessage = async (message: LiveServerMessage, ctx: AudioContext) => {
    // 1. Audio Playback
    const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData) {
        // Only process audio if the context is running
        if (ctx.state === 'suspended') {
             await ctx.resume();
        }

      const audioBuffer = await decodeAudioData(
        base64ToUint8Array(audioData),
        ctx,
        24000
      );
      
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      
      // Schedule seamless playback
      const currentTime = ctx.currentTime;
      const startTime = Math.max(nextStartTimeRef.current, currentTime);
      source.start(startTime);
      nextStartTimeRef.current = startTime + audioBuffer.duration;
      
      sourcesRef.current.add(source);
      source.onended = () => sourcesRef.current.delete(source);
    }

    // 2. Transcription Handling
    if (message.serverContent?.outputTranscription?.text) {
        currentOutputTransRef.current += message.serverContent.outputTranscription.text;
    }
    if (message.serverContent?.inputTranscription?.text) {
        currentInputTransRef.current += message.serverContent.inputTranscription.text;
    }

    if (message.serverContent?.turnComplete) {
        // Commit transcripts to state
        if (currentInputTransRef.current.trim()) {
            const userMsg: ChatMessage = { role: 'user', text: currentInputTransRef.current, timestamp: Date.now() };
            setTranscripts(prev => [...prev, userMsg]);
            currentInputTransRef.current = '';
        }
        if (currentOutputTransRef.current.trim()) {
            const modelMsg: ChatMessage = { role: 'model', text: currentOutputTransRef.current, timestamp: Date.now() };
            setTranscripts(prev => [...prev, modelMsg]);
            currentOutputTransRef.current = '';
        }
    }

    // Handle interruptions
    if (message.serverContent?.interrupted) {
        sourcesRef.current.forEach(s => s.stop());
        sourcesRef.current.clear();
        nextStartTimeRef.current = ctx.currentTime;
        currentOutputTransRef.current = ''; // Clear stale transcription buffer
    }
  };

  const endSession = async () => {
    // Ensure any partial transcripts are captured
    const finalHistory = [...transcripts];
    if (currentInputTransRef.current) finalHistory.push({ role: 'user', text: currentInputTransRef.current, timestamp: Date.now() });
    if (currentOutputTransRef.current) finalHistory.push({ role: 'model', text: currentOutputTransRef.current, timestamp: Date.now() });

    // Cleanup
    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
    
    // Safely close audio contexts
    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
      await inputAudioContextRef.current.close();
    }
    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
      await outputAudioContextRef.current.close();
    }
    
    // Pass history AND images to parent
    onEndSession(finalHistory, evalImagesRef.current);
  };

  useEffect(() => {
    initializeSession();
    return () => {
        // Cleanup on unmount
        if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
        if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
        
        if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
            inputAudioContextRef.current.close();
        }
        if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
            outputAudioContextRef.current.close();
        }
    };
  }, [initializeSession]);

  // Scroll to bottom of chat
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts]);

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white overflow-hidden">
        {/* Header */}
        <div className="flex justify-between items-center p-4 bg-gray-800 border-b border-gray-700">
            <div>
                <h2 className="text-xl font-bold text-blue-400">实时评估</h2>
                <p className="text-sm text-gray-400">场景: {scenario.title}</p>
            </div>
            <button 
                onClick={endSession}
                className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-full font-bold transition-colors"
            >
                结束评估
            </button>
        </div>

        {/* Main Split View */}
        <div className="flex flex-1 overflow-hidden relative">
            
            {/* Left: AI Customer View (Virtual Human) */}
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
                            console.warn("Video failed to load, falling back to avatar image.");
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
                
                {/* Overlay for Persona Info & Status */}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black via-black/60 to-transparent p-6 pt-12 text-center pointer-events-none">
                    <p className="text-blue-400 font-bold tracking-widest text-xs mb-1 uppercase">AI 顾客</p>
                    <h3 className="text-2xl font-light text-white mb-2">{scenario.customerPersona.split('，')[0]}</h3>
                    
                    {!isConnected && (
                        <div className="flex items-center justify-center gap-2 text-yellow-500 animate-pulse">
                            <div className="w-2 h-2 bg-yellow-500 rounded-full"></div>
                            <span className="text-sm">正在建立连接...</span>
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
                />
                <canvas ref={canvasRef} className="hidden" />
                
                {/* Overlay Controls */}
                <div className="absolute bottom-6 left-0 right-0 flex justify-center gap-4">
                     <button 
                        onClick={() => setMicActive(!micActive)}
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

            {/* Transcription Overlay (Floating) */}
            <div className="absolute top-4 right-4 w-80 bg-black/60 backdrop-blur-md rounded-xl p-4 border border-white/10 max-h-[40%] overflow-y-auto scrollbar-hide shadow-xl">
                 <h3 className="text-xs font-bold text-gray-400 uppercase mb-2">实时对话字幕</h3>
                 <div className="space-y-3">
                    {transcripts.map((t, idx) => (
                        <div key={idx} className={`text-sm ${t.role === 'user' ? 'text-green-300' : 'text-blue-300'}`}>
                            <span className="font-bold opacity-75">{t.role === 'user' ? '导购' : '顾客'}:</span> {t.text}
                        </div>
                    ))}
                    <div ref={chatEndRef} />
                 </div>
            </div>

            {/* Error Toast */}
            {error && (
                <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-lg shadow-lg">
                    {error}
                </div>
            )}
        </div>
    </div>
  );
};

export default LiveSession;