        // ==========================================
        // 1. IMPORTS
        // ==========================================
        import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
        import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
        import { getFirestore, doc, setDoc, getDoc, collection, onSnapshot, deleteDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

        // ==========================================
        // 2. GLOBALE VARIABLER
        // ==========================================
        const MAX_HARMONICS = 30; 
        const MANUAL_HARMONICS_COUNT = 16;
        let currentWave = 'sawtooth'; 
        let numHarmonics = 30;
        let fundamentalFreq = 261.63; 
        let lpFilterCutoff = 20000;
        let hpFilterCutoff = 40;
        let oscAmount = 1.0;
        let noiseAmount = 0;
        let globalVolumeAmount = 0.8;
        let pcOctaveShift = 0;
        let displayMode = 'pc';
        let isPolyphonic = true;

        const explanations = {
            sawtooth: "<strong>Sagtann:</strong> Inneholder <em>alle</em> overtoner. Gir en skarp, fyldig klang.",
            square: "<strong>Firkant:</strong> Kun <em>oddetalls-overtoner</em>. Gir en hul, treaktig klang.",
            triangle: "<strong>Triangel:</strong> Oddetalls-overtoner, men svakere. Rund og fløyte-aktig.",
            sine: "<strong>Sinus:</strong> Kun grunntonen! Rund, ren og dyp.",
            manual: "<strong>Orgel:</strong> Bygg lyden selv overtone for overtone med spakene."
        };

        let adsr = { a: 0.1, d: 0.3, s: 0.5, r: 0.8 };
        let lfo = { rate: 5.0, vibrato: 0, tremolo: 0, filterMod: 0 };
        let delayConfig = { time: 0.4, feedback: 0.4, mix: 0.0 };
        let reverbConfig = { time: 3.0, mix: 0.0 }; 

        let manualHarmonics = new Array(MANUAL_HARMONICS_COUNT + 1).fill(0); 
        manualHarmonics[1] = 1.0;

        let audioCtx = null, globalVolumeNode = null, masterOutput = null;
        let lpFilterNode = null, hpFilterNode = null, tremoloGain = null;
        let lfoOsc = null, lfoPitchGain = null, lfoAmpGain = null, lfoFilterGain = null, noiseBuffer = null; 
        let delayNode = null, delayFeedbackGain = null, delayMixGain = null;
        let convolverNode = null, reverbMixGain = null; 

        let isPlaying = false, isSounding = false, animationFrameId = null;
        let activeNotes = [];
        let activeVoices = {};

        const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        let app, auth, db;
        let currentUser = null;
        let unsubscribePresets = null;
        let pendingPresetSelection = null; 
        let storageMode = 'none';
        let authInitialized = false;

        let factoryPresets = {}; 
        let userPresets = {}; 
        let externalPresets = {}; 
        const FACTORY_PRESETS_URL = "https://www.dropbox.com/scl/fi/dwd8vz1g6x3uxdxlo9dai/Lydb-lge-Lab-presets.json?rlkey=593o8azjmedjjcex8n7abcao7&dl=0";

        // ==========================================
        // 3. LYD & VISUALISERING
        // ==========================================
        const waveCanvas = document.getElementById('waveCanvas');
        const waveCtx = waveCanvas ? waveCanvas.getContext('2d') : null;
        const spectrumCanvas = document.getElementById('spectrumCanvas');
        const spectrumCtx = spectrumCanvas ? spectrumCanvas.getContext('2d') : null;
        const adsrCanvas = document.getElementById('adsrCanvas');
        const adsrCtx = adsrCanvas ? adsrCanvas.getContext('2d') : null;

        function getHarmonicAmplitude(type, n) {
            if (type === 'manual') return n <= MANUAL_HARMONICS_COUNT ? manualHarmonics[n] : 0;
            if (type === 'sine') return n === 1 ? 1 : 0;
            if (type === 'sawtooth') return 1 / n;
            if (type === 'square') return n % 2 !== 0 ? 1 / n : 0;
            if (type === 'triangle') {
                if (n % 2 === 0) return 0;
                return (((n - 1) / 2) % 2 === 0 ? 1 : -1) * (1 / (n * n));
            }
            return 0;
        }

        function getVisualFilterMultiplier(freq, lpCut = lpFilterCutoff, hpCut = hpFilterCutoff) { 
            const lpMult = freq >= 20000 ? 1 : 1 / Math.sqrt(1 + Math.pow(freq / lpCut, 8));
            const hpMult = freq <= 40 ? 1 : 1 / Math.sqrt(1 + Math.pow(hpCut / freq, 8));
            return lpMult * hpMult; 
        }

        function updateAudioWaveform() {
            if (!audioCtx) return;
            const limit = currentWave === 'manual' ? MANUAL_HARMONICS_COUNT : numHarmonics;
            const r = new Float32Array(limit + 1), i = new Float32Array(limit + 1);
            for (let n = 1; n <= limit; n++) i[n] = getHarmonicAmplitude(currentWave, n);
            const wave = audioCtx.createPeriodicWave(r, i, { disableNormalization: false });
            for (let vid in activeVoices) {
                if (activeVoices[vid].osc) activeVoices[vid].osc.setPeriodicWave(wave);
            }
        }

        function resizeCanvas(canvas, ctx) {
            if (!canvas || !ctx) return { width: 0, height: 0 };
            const rect = canvas.parentElement.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            ctx.scale(dpr, dpr);
            return { width: rect.width, height: rect.height };
        }

        function drawADSR() {
            if (!adsrCanvas || !adsrCtx) return;
            const dim = resizeCanvas(adsrCanvas, adsrCtx);
            adsrCtx.clearRect(0, 0, dim.width, dim.height);
            
            const pxPerSec = dim.width / 13;
            const xA = adsr.a * pxPerSec;
            const xD = xA + (adsr.d * pxPerSec);
            const xS = xD + (2 * pxPerSec);
            const xR = xS + (adsr.r * pxPerSec);
            
            const yB = dim.height - 5;
            const yT = 5;
            const yS = yB - (adsr.s * (yB - yT));
            
            adsrCtx.strokeStyle = '#333'; adsrCtx.lineWidth = 1; adsrCtx.beginPath();
            adsrCtx.moveTo(0, yT); adsrCtx.lineTo(dim.width, yT); adsrCtx.moveTo(0, yB); adsrCtx.lineTo(dim.width, yB); adsrCtx.stroke();
            
            function traceEnvelopePath() {
                adsrCtx.beginPath();
                adsrCtx.moveTo(0, yB);
                adsrCtx.lineTo(xA, yT);
                if (xD > xA) {
                    const v0 = 1.0;
                    const v1 = Math.max(adsr.s, 0.0001);
                    for (let x = xA; x <= xD; x++) {
                        let t = (x - xA) / (xD - xA);
                        let v_t = v0 * Math.pow(v1/v0, t);
                        let y = yB - (v_t) * (yB - yT);
                        adsrCtx.lineTo(x, y);
                    }
                } else {
                    adsrCtx.lineTo(xD, yS);
                }
                adsrCtx.lineTo(xS, yS);
                if (xR > xS) {
                    const v0 = Math.max(adsr.s, 0.0001);
                    const v1 = 0.0001;
                    for (let x = xS; x <= xR; x++) {
                        let t = (x - xS) / (xR - xS);
                        let v_t = v0 * Math.pow(v1/v0, t);
                        let y = yB - (v_t) * (yB - yT); 
                        adsrCtx.lineTo(x, y);
                    }
                } else {
                    adsrCtx.lineTo(xR, yB);
                }
            }

            traceEnvelopePath();
            adsrCtx.lineTo(xR, yB);
            adsrCtx.lineTo(0, yB);
            adsrCtx.fillStyle = 'rgba(155, 89, 182, 0.3)';
            adsrCtx.fill();

            traceEnvelopePath();
            adsrCtx.strokeStyle = '#9b59b6'; adsrCtx.lineWidth = 2.5; adsrCtx.lineJoin = 'round'; adsrCtx.stroke();
        }

        function drawVisualsDynamic() {
            if (!isSounding && animationFrameId) { 
                cancelAnimationFrame(animationFrameId); 
                animationFrameId = null; 
                drawVisualsStatic(); 
                return; 
            }
            if (!waveCanvas || !waveCtx || !spectrumCanvas || !spectrumCtx) return;

            const waveDims = resizeCanvas(waveCanvas, waveCtx);
            const specDims = resizeCanvas(spectrumCanvas, spectrumCtx);
            const limit = currentWave === 'manual' ? MANUAL_HARMONICS_COUNT : numHarmonics;
            
            let curAmp = 1.0, curCyc = 2.0;
            let effLp = lpFilterCutoff, effHp = hpFilterCutoff;

            if (audioCtx) {
                const lfoVal = Math.sin(audioCtx.currentTime * Math.min(lfo.rate, 20) * Math.PI * 2);
                curAmp = 1.0 - (lfo.tremolo / 200) + (lfoVal * lfo.tremolo / 200);
                curCyc = 2 * (Math.max(10, fundamentalFreq + (lfoVal * lfo.vibrato)) / fundamentalFreq);
                const freqMult = Math.pow(2, (lfoVal * lfo.filterMod) / 1200);
                effLp = Math.min(22000, Math.max(20, lpFilterCutoff * freqMult));
                effHp = Math.min(22000, Math.max(20, hpFilterCutoff * freqMult));
            }
            
            let peakY = 0.01;
            for (let i = 0; i <= 50; i++) {
                let testPhase = (i / 50) * Math.PI * 2;
                let val = 0;
                for (let n = 1; n <= limit; n++) {
                    let a = getHarmonicAmplitude(currentWave, n);
                    if (a !== 0) val += a * getVisualFilterMultiplier(fundamentalFreq * n, effLp, effHp) * Math.sin(n * testPhase);
                }
                if (Math.abs(val) > peakY) peakY = Math.abs(val);
            }
            let dynamicScale = 0.425 / peakY;
            
            waveCtx.clearRect(0, 0, waveDims.width, waveDims.height);
            waveCtx.beginPath(); waveCtx.strokeStyle = currentWave === 'manual' ? '#2ecc71' : '#ff7b00'; waveCtx.lineWidth = 2.5; waveCtx.lineJoin = 'round';
            for (let x = 0; x < waveDims.width; x++) {
                let phase = (x / waveDims.width) * Math.PI * 2 * curCyc;
                let yAmp = 0;
                for (let n = 1; n <= limit; n++) {
                    let a = getHarmonicAmplitude(currentWave, n);
                    if (a !== 0) yAmp += a * getVisualFilterMultiplier(fundamentalFreq * n, effLp, effHp) * Math.sin(n * phase);
                }
                let jitter = (Math.random() - 0.5) * noiseAmount * 1.5;
                let y = (waveDims.height / 2) - (((yAmp * oscAmount * dynamicScale) + jitter) * waveDims.height * curAmp);
                y = Math.max(2, Math.min(waveDims.height - 2, y));
                x === 0 ? waveCtx.moveTo(x, y) : waveCtx.lineTo(x, y);
            }
            waveCtx.stroke();

            spectrumCtx.clearRect(0, 0, specDims.width, specDims.height);
            const limitMax = currentWave === 'manual' ? MANUAL_HARMONICS_COUNT : MAX_HARMONICS;
            const bw = (specDims.width / limitMax) - 2; 
            const maxH = (specDims.height - 15) * curAmp;

            if (noiseAmount > 0) {
                for (let i = 0; i < specDims.width; i += 2) {
                    let nH = Math.random() * noiseAmount * maxH * 0.4;
                    spectrumCtx.fillStyle = 'rgba(149, 165, 166, 0.4)'; spectrumCtx.fillRect(i, specDims.height - nH, 2, nH);
                }
            }

            for (let n = 1; n <= limitMax; n++) {
                let bA = Math.abs(getHarmonicAmplitude(currentWave, n));
                let visualBA = bA * oscAmount;
                let fA = visualBA * getVisualFilterMultiplier(fundamentalFreq * n, effLp, effHp);
                let x = (n - 1) * (specDims.width / limitMax) + 1, y = specDims.height - (fA * maxH);

                spectrumCtx.fillStyle = currentWave === 'manual' ? (n === 1 ? '#4fc3f7' : '#2ecc71') : (n <= limit ? (n === 1 ? '#4fc3f7' : '#ff7b00') : (visualBA > 0 ? '#444444' : '#222222'));
                if (fA > 0) spectrumCtx.fillRect(x, y, bw, fA * maxH);

                if (n <= 16 || n % 5 === 0) { spectrumCtx.fillStyle = '#888'; spectrumCtx.font = '9px sans-serif'; spectrumCtx.textAlign = 'center'; spectrumCtx.fillText(n, x + bw / 2, specDims.height - 2); }
            }

            if (isSounding) animationFrameId = requestAnimationFrame(drawVisualsDynamic);
        }

        function drawVisualsStatic() { 
            isSounding = true; 
            drawVisualsDynamic(); 
            isSounding = false; 
        }

        // ==========================================
        // 4. AUDIO ENGINE
        // ==========================================
        function createReverbBuffer(ctx, duration) {
            const sampleRate = ctx.sampleRate;
            const length = sampleRate * duration;
            const impulse = ctx.createBuffer(2, length, sampleRate);
            const left = impulse.getChannelData(0);
            const right = impulse.getChannelData(1);
            let lastL = 0, lastR = 0;
            
            for (let i = 0; i < length; i++) {
                const decay = Math.pow(1 - i / length, 2.5); 
                const noiseL = (Math.random() * 2 - 1);
                const noiseR = (Math.random() * 2 - 1);
                lastL = noiseL * 0.2 + lastL * 0.8;
                lastR = noiseR * 0.2 + lastR * 0.8;
                
                left[i] = lastL * decay;
                right[i] = lastR * decay;
            }
            return impulse;
        }

        function initAudio() {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                
                globalVolumeNode = audioCtx.createGain();
                globalVolumeNode.gain.value = globalVolumeAmount;
                globalVolumeNode.connect(audioCtx.destination);
                
                masterOutput = audioCtx.createGain(); 
                masterOutput.gain.value = 1.0; 
                
                let compressor = audioCtx.createDynamicsCompressor();
                compressor.threshold.value = -12; 
                compressor.knee.value = 30;
                compressor.ratio.value = 12;
                compressor.attack.value = 0.005;
                compressor.release.value = 0.1;
                compressor.connect(globalVolumeNode);
                
                masterOutput.connect(compressor);
                
                delayNode = audioCtx.createDelay(3.0); delayNode.delayTime.value = delayConfig.time;
                delayFeedbackGain = audioCtx.createGain(); delayFeedbackGain.gain.value = delayConfig.feedback;
                delayMixGain = audioCtx.createGain(); delayMixGain.gain.value = delayConfig.mix;
                convolverNode = audioCtx.createConvolver(); convolverNode.buffer = createReverbBuffer(audioCtx, reverbConfig.time);
                reverbMixGain = audioCtx.createGain(); reverbMixGain.gain.value = reverbConfig.mix;
                
                delayNode.connect(delayFeedbackGain); delayFeedbackGain.connect(delayNode);
                delayNode.connect(delayMixGain); delayMixGain.connect(masterOutput);
                convolverNode.connect(reverbMixGain); reverbMixGain.connect(masterOutput);
                delayMixGain.connect(convolverNode);
                
                tremoloGain = audioCtx.createGain(); tremoloGain.gain.value = 1.0; 
                tremoloGain.connect(masterOutput); tremoloGain.connect(delayNode); tremoloGain.connect(convolverNode);  
                
                lpFilterNode = audioCtx.createBiquadFilter(); lpFilterNode.type = 'lowpass'; lpFilterNode.frequency.value = lpFilterCutoff; lpFilterNode.Q.value = 1; 
                hpFilterNode = audioCtx.createBiquadFilter(); hpFilterNode.type = 'highpass'; hpFilterNode.frequency.value = hpFilterCutoff; hpFilterNode.Q.value = 1;

                hpFilterNode.connect(lpFilterNode); lpFilterNode.connect(tremoloGain); 

                lfoOsc = audioCtx.createOscillator(); lfoOsc.frequency.value = lfo.rate;
                lfoPitchGain = audioCtx.createGain(); lfoPitchGain.gain.value = lfo.vibrato; lfoOsc.connect(lfoPitchGain);
                lfoAmpGain = audioCtx.createGain(); lfoAmpGain.gain.value = lfo.tremolo / 2; lfoOsc.connect(lfoAmpGain); lfoAmpGain.connect(tremoloGain.gain);
                
                lfoFilterGain = audioCtx.createGain(); lfoFilterGain.gain.value = lfo.filterMod; lfoOsc.connect(lfoFilterGain);
                lfoFilterGain.connect(lpFilterNode.detune); lfoFilterGain.connect(hpFilterNode.detune);
                
                lfoOsc.start();

                const bSize = audioCtx.sampleRate * 2; noiseBuffer = audioCtx.createBuffer(1, bSize, audioCtx.sampleRate);
                const out = noiseBuffer.getChannelData(0); for (let i = 0; i < bSize; i++) out[i] = Math.random() * 2 - 1;
            }
        }

        function updateLFO() {
            if (!audioCtx) return;
            if(lfoOsc) lfoOsc.frequency.setTargetAtTime(lfo.rate, audioCtx.currentTime, 0.01);
            if(lfoPitchGain) lfoPitchGain.gain.setTargetAtTime(lfo.vibrato, audioCtx.currentTime, 0.01);
            if(tremoloGain) tremoloGain.gain.setTargetAtTime(1.0 - (lfo.tremolo / 2), audioCtx.currentTime, 0.01);
            if(lfoAmpGain) lfoAmpGain.gain.setTargetAtTime(lfo.tremolo / 2, audioCtx.currentTime, 0.01);
            if (lfoFilterGain) lfoFilterGain.gain.setTargetAtTime(lfo.filterMod, audioCtx.currentTime, 0.01);
        }

        function startVoice(freq, voiceId, velocity = 100) {
            initAudio(); 
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
            
            if (activeVoices[voiceId]) stopVoice(voiceId, true);

            let osc = audioCtx.createOscillator();
            const limit = currentWave === 'manual' ? MANUAL_HARMONICS_COUNT : numHarmonics;
            const r = new Float32Array(limit + 1), i = new Float32Array(limit + 1);
            for (let n = 1; n <= limit; n++) i[n] = getHarmonicAmplitude(currentWave, n);
            osc.setPeriodicWave(audioCtx.createPeriodicWave(r, i, { disableNormalization: false }));
            osc.frequency.value = freq;
            lfoPitchGain.connect(osc.frequency);

            let oscGain = audioCtx.createGain(); oscGain.gain.value = oscAmount; osc.connect(oscGain);

            let nSource = audioCtx.createBufferSource(); nSource.buffer = noiseBuffer; nSource.loop = true;
            let nGain = audioCtx.createGain(); nGain.gain.value = noiseAmount * 0.5; nSource.connect(nGain); 

            let vEnvGain = audioCtx.createGain(); vEnvGain.gain.value = 0;
            oscGain.connect(vEnvGain); nGain.connect(vEnvGain); vEnvGain.connect(hpFilterNode); 

            osc.start(); nSource.start();

            const now = audioCtx.currentTime; 
            const velScale = velocity / 127.0;
            vEnvGain.gain.cancelScheduledValues(now); vEnvGain.gain.setValueAtTime(0, now);
            vEnvGain.gain.linearRampToValueAtTime(0.5 * velScale, now + adsr.a); 
            vEnvGain.gain.exponentialRampToValueAtTime(Math.max(0.5 * adsr.s * velScale, 0.0001), now + adsr.a + adsr.d);

            activeVoices[voiceId] = { osc, oscGain, nSource, nGain, vEnvGain, timeout: null };
            isPlaying = isSounding = true;
            if (!animationFrameId) drawVisualsDynamic();
        }

        function stopVoice(voiceId, hardStop = false) {
            let voice = activeVoices[voiceId];
            if (!voice || !audioCtx) return;
            const now = audioCtx.currentTime; 
            voice.vEnvGain.gain.cancelScheduledValues(now);
            
            if (hardStop) {
                if (voice.timeout) clearTimeout(voice.timeout);
                voice.vEnvGain.gain.setValueAtTime(0, now);
                try {
                    voice.osc.stop(); voice.osc.disconnect();
                    voice.nSource.stop(); voice.nSource.disconnect();
                    voice.vEnvGain.disconnect();
                } catch(e) {}
                delete activeVoices[voiceId];
            } else {
                const currentVal = Math.max(voice.vEnvGain.gain.value, 0.0001);
                voice.vEnvGain.gain.setValueAtTime(currentVal, now); 
                voice.vEnvGain.gain.exponentialRampToValueAtTime(0.0001, now + adsr.r);
                voice.vEnvGain.gain.setValueAtTime(0, now + adsr.r + 0.01);
                if (voice.timeout) clearTimeout(voice.timeout);

                voice.timeout = setTimeout(() => {
                    try {
                        voice.osc.stop(); voice.osc.disconnect();
                        voice.nSource.stop(); voice.nSource.disconnect();
                        voice.oscGain.disconnect(); voice.nGain.disconnect(); voice.vEnvGain.disconnect();
                    } catch(e) {}
                    delete activeVoices[voiceId];
                    if (Object.keys(activeVoices).length === 0) {
                        isSounding = false; drawVisualsStatic(); isPlaying = false;
                    }
                }, adsr.r * 1000 + 50);
            }
        }

        // ==========================================
        // 5. MODALER OG PRESETS (UI LOGIKK)
        // ==========================================
        const modalContent = {
            general: { title: "Synthesizeren", body: "<p>Dette er en virtuell synthesizer. Prøv å trykk på forskjellige moduser og skru på sliderne for å forme lyden!</p>" },
            overtones: {
                title: "Overtoner og Additiv Syntese",
                body: `<p>Når du spiller en tone (for eksempel en C på et piano), hører du egentlig ikke bare én lyd. Du hører en <strong>grunntone</strong> pluss en hel stige av lysere toner som klinger svakt i bakgrunnen. Det er denne stigen vi kaller <strong>overtoner</strong>.</p>
                <h4>Naturens egen gangetabell (og brøker!)</h4>
                <p>Det magiske med disse overtonene er matematikken. Hvis grunntonen din vibrerer med 100 Hz, vil den neste tonen i stigen være nøyaktig <strong>100 Hz &times; 2</strong> (200 Hz). Den neste er <strong>&times; 3</strong> (300 Hz), deretter <strong>&times; 4</strong> (400 Hz), og så videre i en endeløs matematisk rekke.</p>
                <p>Men de er ikke like sterke! For en standard tone (som en Sagtannbølge) følger volumet (amplituden) en brøk: Den 2. overtonen er bare halvparten (1/2) så sterk som grunntonen. Den 3. er en tredjedel (1/3) så sterk, den 4. er en fjerdedel (1/4), og så videre. Legoklossene blir altså mindre og mindre jo høyere vi bygger!</p>
                <h4>Additiv syntese (Bygg med Lego)</h4>
                <p>Se for deg at en helt ren tone (en Sinusbølge) er en enkelt legokloss. Hvis vi stabler mange slike x2, x3 og x4-klosser oppå hverandre i ulike mønstre, endrer vi selve <em>formen</em> på lyden, og vi kan få f.eks. en skarp Sagtannbølge!</p>
                <p><strong>Praktisk test:</strong><br>
                1. Trykk på "Sagtann"-knappen.<br>
                2. Se i det nederste vinduet (Spektrum). Her er stolpe nr. 1 grunntonen (&times;1), stolpe nr. 2 er &times;2-overtonen osv. Du kan se at stolpene blir kortere (lavere volum) jo lenger til høyre de er.<br>
                3. Dra i slideren for "Overtoner" og se stolpene forsvinne. Hør hvordan lyden blir rundere (og kjedeligere) når vi fjerner de øverste klossene.<br>
                4. (Ekspert) Bytt til "Orgel". Her er spakene markert med 1x, 2x, 3x! Prøv å dra opp spakene og bygg din helt egen klang, kloss for kloss.</p>`
            },
            mixer: {
                title: "Lydkilder (Oscillator og Mikser)",
                body: `<p>Når du snakker eller synger, lager stemmebåndene dine vibrasjoner. I en synthesizer er det <strong>Oscillatoren</strong> (Tone) som er stemmebåndet! Den lager en jevn, summende tone.</p>
                <h4>Hvit støy (White Noise)</h4>
                <p>Noen ganger trenger vi lyder som ikke er klare toner, for eksempel lyden av vind, havet, eller et trommeslag. Da bruker vi <strong>Støy</strong>. Hvit støy er bokstavelig talt <em>alle frekvenser spilt på likt</em> – akkurat som at hvitt lys er alle farger blandet sammen. Prøv å skru ned oscillatoren og opp støyen!</p>`
            },
            filter: {
                title: "Lowpass og Highpass Filter (Subtraktiv syntese)",
                body: `<p>Hvis Oscillatoren er legoklossene dine, er Filteret saksen din. Å bruke et filter kalles <strong>Subtraktiv Syntese</strong>, fordi vi <em>trekker fra</em> lyd.</p>
                <p>Et <strong>Lowpass-filter</strong> lar de dype lydene (low) passere (pass), mens det fjerner de lyse og skarpe overtonene. Det fungerer akkurat som å holde en tjukk pute foran en høyttaler.</p>
                <p>Et <strong>Highpass-filter</strong> gjør det motsatte: det kutter vekk grunntonen og all den dype bassen, og slipper bare igjennom de lyse, krispe frekvensene.</p>
                <p><strong>Praktisk test:</strong> Dra Lowpass-slideren langt ned, og Highpass-slideren langt opp. Nå har du fjernet både toppen og bunnen, og sitter igjen med en tynn lyd – akkurat som i en gammel telefon!</p>`
            },
            adsr: {
                title: "Volum-konvolutt (ADSR)",
                body: `<p>En tone er ikke bare lys eller mørk – den lever i <em>tid</em>. Hvis du slår på en skarptromme, smeller det og dør ut med en gang. Spiller du fiolin, kan lyden smyge seg sakte inn, holdes i mange sekunder, og dø sakte ut. Vi styrer dette med en konvolutt (Envelope) kalt ADSR:</p>
                <ul>
                    <li><strong>A for Attack (Angrep):</strong> Hvor lang tid det tar fra du trykker på tangenten til lyden når maks volum. (0 sekunder = smell, 2 sekunder = myk innfading).</li>
                    <li><strong>D for Decay (Fall):</strong> Tiden lyden bruker på å falle ned til hvilepulsen (Sustain) etter det første slaget. Denne er logaritmisk, som betyr at den faller raskt først og flater ut mot slutten.</li>
                    <li><strong>S for Sustain (Hvilepuls):</strong> Hvor <em>høyt</em> volumet skal være så lenge du holder tangenten nede.</li>
                    <li><strong>R for Release (Slipp):</strong> Hva skjer når du slipper knappen? Også logaritmisk – dør ut naturlig som et ekte rom eller en kondensator i en analog synth.</li>
                </ul>`
            },
            lfo: {
                title: "Modulasjon (LFO og FM-syntese)",
                body: `<p><strong>LFO</strong> står for <em>Low Frequency Oscillator</em>. Tenk på det som en usynlig robothånd eller en skjult, ekstra motor i synthesizeren som skrur på knappene for deg mens du spiller!</p>
                
                <h4>Lav hastighet (Rytme og bevegelse)</h4>
                <p>Sett hastigheten lavt (f.eks. mellom 1 og 10 Hz) og velg hva motoren skal styre:</p>
                <ul>
                    <li><strong>AM-volum (Tremolo):</strong> Skrur volumet opp og ned. Du får en pulserende effekt, som å slå lyden av og på raskt.</li>
                    <li><strong>FM-Pitch (Vibrato):</strong> Skrur selve tonehøyden (Hertz) opp og ned. Dette gir en syngende effekt, akkurat som når fiolinister vugger på fingeren sin på strengen.</li>
                    <li><strong>Filter-sweep:</strong> Åpner og lukker filteret. Skaper en levende, sveipende "wub-wub"-lyd som er selve hjertet i mye moderne elektronisk musikk.</li>
                </ul>

                <h4>Høy hastighet: Fra rytme til metall (Audio Rate Modulasjon)</h4>
                <p>Nå kommer magien: Hva skjer hvis "robothånden" rister på knappen ekstremt fort? Skru hastigheten (LFO Rate) helt opp (til 50 - 100 Hz)!</p>
                <p>Når motoren svinger så raskt, klarer ikke øret vårt lenger å oppfatte det som en vibrato (en rytmisk opp-ned-bevegelse). I stedet hører vi selve <em>bevegelsen</em> som en egen tone! Når denne nye hastighets-tonen kolliderer med grunntonen du spiller, oppstår <strong>Frekvensmodulasjon (FM-syntese)</strong>.</p>
                <p>Tonene "knuser" hverandre og tvinger frem et vell av helt nye overtoner (kalt sidebands). En kjedelig sinusbølge forvandles plutselig til klokkeklanger, gongs, knusende støy, eller aggressive bass-teksturer. Dette er nøyaktig den samme teknologien Yamaha brukte i 80-talls-legenden DX7, og som lydbrikken i Sega Mega Drive var basert på!</p>
                
                <p style="background: rgba(255,123,0,0.1); padding: 10px; border-radius: 5px; border-left: 3px solid var(--accent); margin-top: 15px;"><strong>Test det ut:</strong> Velg "Sinus", skru "FM-Pitch (Vibrato)" til 100%, og dra "Hastighet" opp og ned mens du holder en tone. Hør hvordan lyden forvandles fra dyp og myk, til hylende, knallhardt metall!</p>`
            },
            delay: {
                title: "Delay / Ekko",
                body: `<p>En <strong>Delay</strong>-effekt tar opp lyden du nettopp spilte, og sender tilbake til deg etter en liten stund. Det fungerer akkurat som å rope mot en fjellvegg!</p>
                <ul>
                    <li><strong>Tid (Hastighet):</strong> Avstanden til fjellveggen. Bestemmer hvor lang tid det tar før ekkoet smeller tilbake (fra lynraske maskin-repetisjoner til store, trege daler).</li>
                    <li><strong>Feedback (Lengde):</strong> Hvis ekkoet treffer deg og spretter tilbake mot fjellveggen <em>enda</em> en gang, får vi et nytt ekko. Høy feedback gir evigvarende haler av ekko. Lav feedback gir bare ett lite "Hallo... hallo".</li>
                    <li><strong>Mix (Volum):</strong> Hvor høyt ekkoet er, sammenlignet med det du faktisk spiller med fingrene.</li>
                </ul>`
            },
            reverb: {
                title: "Reverb / Romklang",
                body: `<p><strong>Reverb (Klang)</strong> etterligner hvordan lyd oppfører seg i et fysisk rom. Når du klapper i hendene i en stor kirke, spretter lyden mot tusenvis av overflater og skaper en tett, svømmende sky av ekko.</p>
                <ul>
                    <li><strong>Størrelse (Tid):</strong> Bestemmer hvor lang tid det tar før klangen dør ut i det fiktive rommet vårt. En enorm katedral eller en dyp hule har lang tid.</li>
                    <li><strong>Mix (Volum):</strong> Hvor mye klang som skal blandes med den tørre originallyden. Setter du denne høyt, høres det ut som om instrumentet står langt, langt unna.</li>
                </ul>
                <p><strong>Tips for magi:</strong> For å skape en dvelende og filmatisk atmosfære, prøv dette: Sett en lang Attack på ADSR-en, en lang og treig Delay, og dra opp Reverb Størrelse og Mix. Da får du et fantastisk, svevende lydlandskap som forsvinner sakte ut i det fjerne når du slipper tangenten.</p>`
            },
            mystery: {
                title: "Mysteriet om tonen E og pianoets 'Juks'",
                body: `<p>Har du lagt merke til at det står desimaler på tonene (f.eks. 261.6 Hz)? Har du noen gang tenkt over hvordan man egentlig bestemmer hvor mange Hertz en tone skal ha?</p>
                <h4>Pythagoras og brøken 1,5</h4>
                <p>Naturen har sin egen uendelige skala, <em>naturtoneskalaen</em> (som du spiller på en lur eller en seljefløyte). I den skalaen er tonene nøyaktig x2, x3, x4, x5 osv. av grunntonen. Dette er de eksakt samme overtonene du kan se i "Spektrum"-vinduet her i laben!</p>
                <p>I antikken ble matematikeren Pythagoras helt fascinert av forholdet mellom grunntonen og akkurat den overtonen som svinger 1,5 ganger så fort (x3 delt på x2 - det vi i dag kaller en kvint). Hvis du spiller en <strong>A (440 Hz)</strong>, er denne tonen <br>440 Hz × 1,5 = <strong>660 Hz (tonen E)</strong>.</p>
                <p>Pythagoras bestemte seg for å bygge <em>hele</em> skalaen sin bare ved å bruke denne ene 1,5-regelen. Han tok en tone, ganget med 1,5 for å finne neste, og fortsatte slik for å regne ut alle notene i musikken. Han ignorerte altså resten av overtonene som luren bruker.</p>
                <h4>Problemet: Matte-sirkelen som krasjet</h4>
                <p>Problemet oppsto da man prøvde å lage tangentinstrumenter. Hvis man stablet tolv slike "1,5-toner" oppå hverandre for å komme rundt hele skalaen og tilbake til start, bommet man! Regnestykket gikk rett og slett ikke opp. Et piano stemt etter Pythagoras' regel låt vakkert i én bestemt toneart, men byttet man til en annen, låt det grusomt surt (man kalte det "ulvehyl").</p>
                <h4>Løsningen: Likesvevende stemming (Jukset)</h4>
                <p>For at du skal kunne spille alle sanger i verden på det samme tastaturet uten å stemme det om, måtte matematikerne inngå et kompromiss med naturen. I stedet for Pythagoras' perfekte brøk (1,5), delte de opp oktaven i 12 nøyaktig like store, matematiske biter med en veldig lang formel (12-roten av 2).</p>
                <p>Resultatet? Tonen E på pianoet ditt er ikke naturens 660,0 Hz. Den er flyttet bittelitt ned til <strong>659,25 Hz</strong>.</p>
                <p>Så neste gang du spiller på et keyboard, kan du tenke på at <em>hver eneste tone (bortsett fra oktavene) faktisk er bittelitt falsk med vilje</em>, bare for at musikken vår skal fungere!</p>`
            }
        };

        function openModal(section) {
            const mTitle = document.getElementById('modalTitle');
            const mBody = document.getElementById('modalBody');
            if (mTitle && mBody && modalContent[section]) {
                mTitle.innerText = modalContent[section].title;
                mBody.innerHTML = modalContent[section].body;
                const infoModal = document.getElementById('infoModal');
                if (infoModal) infoModal.style.display = 'flex';
            }
        }
        
        function closeModal(e) { if(e) e.stopPropagation(); const m = document.getElementById('infoModal'); if (m) m.style.display = 'none'; }
        function closePresetModal(e) { if(e) e.stopPropagation(); const m = document.getElementById('presetModal'); if (m) m.style.display = 'none'; }
        function closeShareModal(e) { if(e) e.stopPropagation(); const m = document.getElementById('shareModal'); if (m) m.style.display = 'none'; }

        const infoModal = document.getElementById('infoModal');
        if (infoModal) infoModal.addEventListener('click', closeModal);
        const infoModalContent = document.getElementById('infoModalContent');
        if (infoModalContent) infoModalContent.addEventListener('click', e => e.stopPropagation());
        const infoModalClose = document.getElementById('infoModalClose');
        if (infoModalClose) infoModalClose.addEventListener('click', closeModal);

        const presetModal = document.getElementById('presetModal');
        if (presetModal) presetModal.addEventListener('click', closePresetModal);
        const presetModalContent = document.getElementById('presetModalContent');
        if (presetModalContent) presetModalContent.addEventListener('click', e => e.stopPropagation());
        const presetModalClose = document.getElementById('presetModalClose');
        if (presetModalClose) presetModalClose.addEventListener('click', closePresetModal);

        const shareModal = document.getElementById('shareModal');
        if (shareModal) shareModal.addEventListener('click', closeShareModal);
        const shareModalContent = document.getElementById('shareModalContent');
        if (shareModalContent) shareModalContent.addEventListener('click', e => e.stopPropagation());
        const shareModalClose = document.getElementById('shareModalClose');
        if (shareModalClose) shareModalClose.addEventListener('click', closeShareModal);

        document.querySelectorAll('.info-btn, .mystery-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const infoType = btn.getAttribute('data-info');
                if (infoType && modalContent[infoType]) openModal(infoType);
            });
        });

        function updatePresetDropdown(selectValue = "") {
            const factoryGroup = document.getElementById('factoryPresetsGroup');
            const userGroup = document.getElementById('userPresetsGroup');
            const externalGroup = document.getElementById('externalPresetsGroup');
            const selectEl = document.getElementById('presetSelect');
            
            if (factoryGroup) factoryGroup.innerHTML = ''; 
            if (userGroup) userGroup.innerHTML = ''; 
            if (externalGroup) externalGroup.innerHTML = '';
            
            if (externalGroup && Object.keys(externalPresets).length > 0) {
                for (let name in externalPresets) {
                    let opt = document.createElement('option');
                    opt.value = "external|" + name;
                    opt.text = name;
                    externalGroup.appendChild(opt);
                }
                externalGroup.style.display = '';
            } else if (externalGroup) {
                externalGroup.style.display = 'none';
            }

            if (factoryGroup) {
                for (let name in factoryPresets) {
                    let opt = document.createElement('option');
                    opt.value = "factory|" + name;
                    opt.text = name;
                    factoryGroup.appendChild(opt);
                }
            }
            
            if (userGroup) {
                for (let name in userPresets) {
                    let opt = document.createElement('option');
                    opt.value = "user|" + name;
                    opt.text = name;
                    userGroup.appendChild(opt);
                }
            }

            if (!selectEl) return;

            let unsavedOpt = document.getElementById('unsavedOption');
            if (unsavedOpt) unsavedOpt.remove();

            if (selectValue === "unsaved") {
                let opt = document.createElement('option');
                opt.id = "unsavedOption";
                opt.value = "unsaved";
                opt.text = "-- Delt lyd (ulagret) --";
                opt.style.fontStyle = "italic";
                selectEl.insertBefore(opt, selectEl.firstChild);
                selectEl.value = "unsaved";
                const delBtn = document.getElementById('deletePresetBtn');
                if (delBtn) delBtn.style.display = 'none';
            } else {
                let optionExists = false;
                if (selectValue) {
                    for (let i = 0; i < selectEl.options.length; i++) {
                        if (selectEl.options[i].value === selectValue) {
                            optionExists = true;
                            break;
                        }
                    }
                }

                if (optionExists) {
                    selectEl.value = selectValue;
                    const delBtn = document.getElementById('deletePresetBtn');
                    if (delBtn) delBtn.style.display = selectValue.startsWith('user|') ? 'inline-block' : 'none';
                } else if (selectEl.options.length > 0) {
                    selectEl.selectedIndex = 0;
                    const delBtn = document.getElementById('deletePresetBtn');
                    if (delBtn) delBtn.style.display = selectEl.options[0].value.startsWith('user|') ? 'inline-block' : 'none';
                    if (selectValue !== "") {
                        selectEl.dispatchEvent(new Event('change'));
                    }
                } else {
                    const delBtn = document.getElementById('deletePresetBtn');
                    if (delBtn) delBtn.style.display = 'none';
                }
            }
        }

        function showErrorBanner(message) {
            const banner = document.getElementById('urlErrorBanner');
            if (banner) {
                banner.textContent = message;
                banner.style.display = 'block';
                setTimeout(() => { banner.style.display = 'none'; }, 8000);
            }
        }

        async function loadFactoryPresets() {
            factoryPresets = {
                "Initiell Patch": {
                    "wave": "sawtooth",
                    "sliderValues": {
                        "harmonicsSlider": "30", "oscMix": "100", "noiseMix": "0",
                        "cutoff": "20000", "hpCutoff": "40",
                        "envA": "0.1", "envD": "0.3", "envS": "0.5", "envR": "0.8",
                        "lfoRate": "39.5", "lfoVibrato": "0", "lfoTremolo": "0", "lfoFilter": "0",
                        "delayTime": "0.4", "delayFeedback": "40", "delayMix": "0",
                        "reverbTime": "3.0", "reverbMix": "0"
                    }
                }
            };

            let localLoaded = false;
            try {
                const localResponse = await fetch('factory_presets.json?v=' + new Date().getTime(), { cache: 'no-store' });
                if (localResponse.ok) {
                    const localData = await localResponse.json();
                    factoryPresets = { ...factoryPresets, ...localData };
                    localLoaded = true;
                }
            } catch (error) {}

            if (!localLoaded) {
                try {
                    let fetchUrl = FACTORY_PRESETS_URL;
                    if (fetchUrl.includes('dropbox.com')) {
                        try {
                            let urlObj = new URL(fetchUrl);
                            urlObj.hostname = 'dl.dropboxusercontent.com';
                            urlObj.searchParams.delete('dl');
                            fetchUrl = urlObj.toString();
                        } catch(e) {
                            fetchUrl = fetchUrl.replace('www.dropbox.com', 'dl.dropboxusercontent.com');
                        }
                    }
                    const response = await fetch(fetchUrl, { cache: 'no-store' });
                    if (response.ok) {
                        const data = await response.json();
                        factoryPresets = { ...factoryPresets, ...data };
                    }
                } catch (error) {}
            }
            updatePresetDropdown();
        }

        async function fetchExternalUrl(presetsUrl) {
            if (presetsUrl.includes('dropbox.com')) {
                try {
                    let urlObj = new URL(presetsUrl);
                    urlObj.hostname = 'dl.dropboxusercontent.com';
                    urlObj.searchParams.delete('dl');
                    presetsUrl = urlObj.toString();
                } catch(e) {
                    presetsUrl = presetsUrl.replace('www.dropbox.com', 'dl.dropboxusercontent.com');
                }
            }

            const response = await fetch(presetsUrl, { cache: 'no-store' });
            if (!response.ok) throw new Error(`Serveren svarte med status ${response.status}`);
            const data = await response.json();
            
            if (typeof data === 'object' && data !== null) {
                if (data.wave && data.sliderValues) {
                    externalPresets = { "Delt lyd": data };
                } else {
                    externalPresets = data;
                }
                return true;
            }
            throw new Error("Ugyldig JSON-format");
        }

        async function loadExternalPresets() {
            const urlParams = new URLSearchParams(window.location.search);
            let presetsUrl = urlParams.get('presets');
            if (presetsUrl) {
                try {
                    await fetchExternalUrl(presetsUrl);
                } catch (error) {
                    showErrorBanner("Klarte ikke å hente inn presets fra URL-en. Sjekk at lenken er riktig, og at den peker til en gyldig fil.");
                }
            }
            updatePresetDropdown();
        }

        function getPresetState() {
            const state = { wave: currentWave, sliderValues: {} };
            document.querySelectorAll('input[type="range"]').forEach(inp => {
                if (inp.id && inp.id !== 'freqSlider' && inp.id !== 'globalMasterVol') { 
                    state.sliderValues[inp.id] = inp.value;
                }
            });
            return state;
        }

        function applyPresetState(state) {
            if (!document.body.classList.contains('expert-mode')) {
                const usesAdv = (
                    parseFloat(state.sliderValues.lfoVibrato || 0) > 0 ||
                    parseFloat(state.sliderValues.lfoTremolo || 0) > 0 ||
                    parseFloat(state.sliderValues.lfoFilter || 0) > 0 ||
                    parseFloat(state.sliderValues.delayMix || 0) > 0 ||
                    parseFloat(state.sliderValues.reverbMix || 0) > 0 ||
                    state.wave === 'manual'
                );
                if (usesAdv) {
                    setExpertMode(true, true);
                }
            }

            const waveBtn = document.querySelector(`.wave-btn[data-wave="${state.wave}"]`);
            if(waveBtn) waveBtn.click();
            
            for (const [id, value] of Object.entries(state.sliderValues)) {
                if (id === 'globalMasterVol') continue; 
                const el = document.getElementById(id);
                if (el) {
                    el.value = value;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }

        const presetSelect = document.getElementById('presetSelect');
        if (presetSelect) {
            presetSelect.addEventListener('change', (e) => {
                const val = e.target.value;
                const delBtn = document.getElementById('deletePresetBtn');
                
                if (val !== "unsaved") {
                     let unsavedOpt = document.getElementById('unsavedOption');
                     if (unsavedOpt) unsavedOpt.remove();
                }

                if (!val || val === "unsaved") {
                    if (delBtn) delBtn.style.display = 'none';
                    e.target.blur(); 
                    return;
                }
                
                const [type, name] = val.split('|');
                if (type === 'factory' && factoryPresets[name]) {
                    applyPresetState(factoryPresets[name]);
                    if (delBtn) delBtn.style.display = 'none';
                } else if (type === 'user' && userPresets[name]) {
                    applyPresetState(userPresets[name]);
                    if (delBtn) delBtn.style.display = 'inline-block';
                } else if (type === 'external' && externalPresets[name]) {
                    applyPresetState(externalPresets[name]);
                    if (delBtn) delBtn.style.display = 'none';
                }
                e.target.blur(); 
            });
        }

        function openSavePresetModal() {
            const pTitle = document.getElementById('presetModalTitle');
            const pBody = document.getElementById('presetModalBody');
            
            if (pTitle && pBody) {
                pTitle.innerText = "Lagre Preset";
                pBody.innerHTML = `
                    <p style="margin-top: 0;">Skriv inn et navn på den nye lyden din:</p>
                    <input type="text" id="presetNameInput" placeholder="Min fete synthlyd..." style="width: 100%; padding: 10px; margin-bottom: 20px; background: #111; color: white; border: 1px solid #444; border-radius: 4px; font-family: inherit; font-size: 14px; outline: none;">
                    <div style="display: flex; gap: 10px; justify-content: flex-end;">
                        <button class="preset-btn" id="btnCancelPresetSave" style="background: #333;">Avbryt</button>
                        <button class="preset-btn" id="btnConfirmPresetSave" style="background: var(--accent); color: #111;">Lagre Lyd</button>
                    </div>
                `;
                const modal = document.getElementById('presetModal');
                if (modal) modal.style.display = 'flex';
                
                const cancelBtn = document.getElementById('btnCancelPresetSave');
                const confirmBtn = document.getElementById('btnConfirmPresetSave');
                if (cancelBtn) cancelBtn.addEventListener('click', closePresetModal);
                if (confirmBtn) confirmBtn.addEventListener('click', confirmSavePreset);

                setTimeout(() => {
                    const inp = document.getElementById('presetNameInput');
                    if(inp) { inp.focus(); inp.addEventListener('keydown', (e) => { if(e.key==='Enter') confirmSavePreset(); }); }
                }, 50);
            }
        }

        function openDeletePresetModal(name) {
            const pTitle = document.getElementById('presetModalTitle');
            const pBody = document.getElementById('presetModalBody');
            
            if (pTitle && pBody) {
                pTitle.innerText = "Slett Preset";
                pBody.innerHTML = `
                    <p style="margin-top: 0;">Er du helt sikker på at du vil slette preset <strong>${name}</strong> permanent?</p>
                    <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px;">
                        <button class="preset-btn" id="btnCancelPresetDel" style="background: #333;">Behold den</button>
                        <button class="preset-btn" id="btnConfirmPresetDel" style="background: #c0392b; color: white;">Ja, slett</button>
                    </div>
                `;
                const modal = document.getElementById('presetModal');
                if (modal) modal.style.display = 'flex';
                
                const cancelBtn = document.getElementById('btnCancelPresetDel');
                const confirmBtn = document.getElementById('btnConfirmPresetDel');
                if (cancelBtn) cancelBtn.addEventListener('click', closePresetModal);
                if (confirmBtn) confirmBtn.addEventListener('click', () => confirmDeletePreset(name));
            }
        }

        async function confirmSavePreset() {
            const nameInput = document.getElementById('presetNameInput');
            if (!nameInput) return;
            const name = nameInput.value;
            if (!name || name.trim() === "") return;
            
            const presetName = name.trim();
            const state = getPresetState();
            pendingPresetSelection = "user|" + presetName;

            if (storageMode === 'cloud' && currentUser && typeof db !== 'undefined' && db) {
                try {
                    const presetRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'presets', presetName);
                    await setDoc(presetRef, state);
                } catch(e) {}
            } else if (storageMode === 'local') {
                userPresets[presetName] = state;
                try {
                    localStorage.setItem('lydlab_presets', JSON.stringify(userPresets));
                    updatePresetDropdown(pendingPresetSelection);
                    pendingPresetSelection = null;
                } catch (e) {
                    showErrorBanner("Klarte ikke å lagre preset i nettleseren.");
                }
            }
            closePresetModal();
        }

        async function confirmDeletePreset(name) {
            if (storageMode === 'cloud' && currentUser && typeof db !== 'undefined' && db) {
                try {
                    const presetRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'presets', name);
                    await deleteDoc(presetRef);
                } catch(e) {}
            } else if (storageMode === 'local') {
                delete userPresets[name];
                try {
                    localStorage.setItem('lydlab_presets', JSON.stringify(userPresets));
                    updatePresetDropdown();
                } catch(e) {}
            }
            closePresetModal();
        }

        const savePresetBtn = document.getElementById('savePresetBtn');
        if (savePresetBtn) savePresetBtn.addEventListener('click', openSavePresetModal);
        
        const deletePresetBtn = document.getElementById('deletePresetBtn');
        if (deletePresetBtn) {
            deletePresetBtn.addEventListener('click', () => {
                const select = document.getElementById('presetSelect');
                if (select) {
                    const val = select.value;
                    if (!val.startsWith('user|')) return;
                    const name = val.split('|')[1];
                    openDeletePresetModal(name);
                }
            });
        }

        function openShareModal() {
            const currentState = getPresetState();
            const jsonString = JSON.stringify(currentState, null, 2);
            const shareTextarea = document.getElementById('shareTextarea');
            const shareStatusMsg = document.getElementById('shareStatusMsg');
            
            if (shareTextarea) shareTextarea.value = jsonString;
            if (shareStatusMsg) shareStatusMsg.style.display = 'none';
            const modal = document.getElementById('shareModal');
            if (modal) modal.style.display = 'flex';
        }

        function copyPresetToClipboard() {
            const textarea = document.getElementById('shareTextarea');
            if (!textarea) return;
            textarea.select();
            document.execCommand('copy');
            const msg = document.getElementById('shareStatusMsg');
            if (msg) {
                msg.textContent = "✅ Koden er kopiert til utklippstavlen!";
                msg.style.color = "#2ecc71";
                msg.style.display = "block";
            }
        }

        function applyPastedPreset() {
            const textarea = document.getElementById('shareTextarea');
            if (!textarea) return;
            const text = textarea.value;
            const msg = document.getElementById('shareStatusMsg');
            if (!msg) return;

            try {
                const state = JSON.parse(text);
                const keys = Object.keys(state);
                let actualState = state;
                
                if (keys.length === 1 && state[keys[0]].wave && state[keys[0]].sliderValues) {
                    actualState = state[keys[0]];
                }
                
                if (actualState && actualState.wave && actualState.sliderValues) {
                    applyPresetState(actualState);
                    updatePresetDropdown("unsaved");
                    msg.textContent = "✅ Lyden ble lastet inn! Trykk 'Lagre ny' for å beholde den.";
                    msg.style.color = "#3498db";
                    msg.style.display = "block";
                    setTimeout(() => { closeShareModal(); }, 1500);
                } else {
                    throw new Error("Feil format");
                }
            } catch (err) {
                msg.textContent = "❌ Klarte ikke å lese koden. Er du sikker på at den ble kopiert riktig?";
                msg.style.color = "#e74c3c";
                msg.style.display = "block";
            }
        }

        const sharePresetBtn = document.getElementById('sharePresetBtn');
        if (sharePresetBtn) sharePresetBtn.addEventListener('click', openShareModal);
        
        const btnCopyShareCode = document.getElementById('btnCopyShareCode');
        if (btnCopyShareCode) btnCopyShareCode.addEventListener('click', copyPresetToClipboard);
        
        const btnApplyShareCode = document.getElementById('btnApplyShareCode');
        if (btnApplyShareCode) btnApplyShareCode.addEventListener('click', applyPastedPreset);
        
        const btnImportFromUrl = document.getElementById('btnImportFromUrl');
        if (btnImportFromUrl) {
            btnImportFromUrl.addEventListener('click', async () => {
                const urlInput = document.getElementById('importUrlInput');
                if (!urlInput) return;
                const urlVal = urlInput.value.trim();
                const msg = document.getElementById('shareStatusMsg');
                if(!urlVal || !msg) return;
                
                msg.style.display = 'none';
                btnImportFromUrl.textContent = "Henter...";
                
                try {
                    await fetchExternalUrl(urlVal);
                    updatePresetDropdown();
                    msg.textContent = "✅ Lyder lastet inn fra lenken! Du finner dem i rullegardinmenyen.";
                    msg.style.color = "#3498db";
                    msg.style.display = "block";
                    urlInput.value = "";
                    
                    const firstPresetName = Object.keys(externalPresets)[0];
                    if (firstPresetName) {
                        const val = "external|" + firstPresetName;
                        const select = document.getElementById('presetSelect');
                        if (select) {
                            select.value = val;
                            select.dispatchEvent(new Event('change'));
                        }
                    }
                    setTimeout(() => { closeShareModal(); }, 2500);
                } catch(e) {
                    msg.textContent = "❌ Klarte ikke å hente filen. Sjekk at lenken går direkte til en .json-fil.";
                    msg.style.color = "#e74c3c";
                    msg.style.display = "block";
                } finally {
                    btnImportFromUrl.textContent = "Hent lyder";
                }
            });
        }


        // ==========================================
        // 6. STORAGE, SETTINGS & FIREBASE INIT
        // ==========================================
        function isLocalStorageAvailable() {
            try { const test = '__storage_test__'; localStorage.setItem(test, test); localStorage.removeItem(test); return true; } catch (e) { return false; }
        }

        function updateGlobalVolumeUI(val, skipStorage = false) {
            globalVolumeAmount = val;
            const percent = Math.round(val * 100);
            
            const slider = document.getElementById('globalMasterVol');
            if (slider) slider.value = percent;
            
            const valDisp = document.getElementById('globalMasterVal');
            if (valDisp) valDisp.textContent = percent + ' %';
            
            const loader = document.getElementById('masterVolLoader');
            const controls = document.getElementById('masterVolControls');
            if (loader) loader.style.display = 'none';
            if (controls) controls.style.display = 'flex';

            if (audioCtx && globalVolumeNode) {
                globalVolumeNode.gain.setTargetAtTime(globalVolumeAmount, audioCtx.currentTime, 0.05);
            }

            if (!skipStorage) {
                if (storageMode === 'cloud' && currentUser && typeof db !== 'undefined' && db) {
                    try {
                        const settingsRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'settings', 'preferences');
                        setDoc(settingsRef, { masterVolume: globalVolumeAmount }, { merge: true });
                    } catch(e) {}
                } else if (storageMode === 'local') {
                    try { localStorage.setItem('lydlab_masterVolume', globalVolumeAmount); } catch(e) {}
                }
            }
        }

        async function setExpertMode(isExpert, skipStorage = false) {
            const expertToggleBtn = document.getElementById('expertToggleBtn');
            if (isExpert) {
                document.body.classList.add('expert-mode');
                if(expertToggleBtn) {
                    expertToggleBtn.innerHTML = 'Skjul avansert (Nybegynner) 🙈';
                    expertToggleBtn.style.backgroundColor = '#333';
                    expertToggleBtn.style.color = '#fff';
                    expertToggleBtn.style.borderColor = '#444';
                }
            } else {
                document.body.classList.remove('expert-mode');
                if(expertToggleBtn) {
                    expertToggleBtn.innerHTML = 'Vis avansert (LFO, Ekko) 🚀';
                    expertToggleBtn.style.backgroundColor = 'rgba(142, 68, 173, 0.2)';
                    expertToggleBtn.style.color = '#d2b4de';
                    expertToggleBtn.style.borderColor = 'var(--reverb-color)';
                }
                if (typeof currentWave !== 'undefined' && currentWave === 'manual') {
                    const sawBtn = document.querySelector('.wave-btn[data-wave="sawtooth"]');
                    if (sawBtn) sawBtn.click();
                }
            }
            
            if (!skipStorage) {
                if (storageMode === 'cloud' && currentUser && typeof db !== 'undefined' && db) {
                    try {
                        const settingsRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'settings', 'preferences');
                        await setDoc(settingsRef, { isExpertMode: isExpert }, { merge: true });
                    } catch (e) {}
                } else if (storageMode === 'local') {
                    try { localStorage.setItem('lydlab_expertMode', isExpert); } catch(e) {}
                }
            }
            setTimeout(() => { if(typeof drawADSR === 'function') { drawADSR(); drawVisualsStatic(); } }, 50);
        }

        async function fetchSettings() {
            if (!currentUser || storageMode !== 'cloud') return;
            let loadedVolume = 0.8;
            try {
                const docSnap = await getDoc(doc(db, 'artifacts', appId, 'users', currentUser.uid, 'settings', 'preferences'));
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    if (data.isExpertMode !== undefined) setExpertMode(data.isExpertMode, true); 
                    if (data.masterVolume !== undefined) loadedVolume = data.masterVolume;
                }
            } catch (e) {}
            updateGlobalVolumeUI(loadedVolume, true); 
        }

        function setupPresetsListener() {
            if (!currentUser || !db || storageMode !== 'cloud') return;
            const presetsRef = collection(db, 'artifacts', appId, 'users', currentUser.uid, 'presets');
            unsubscribePresets = onSnapshot(presetsRef, (snapshot) => {
                const newPresets = {};
                snapshot.forEach((doc) => { newPresets[doc.id] = doc.data(); });
                userPresets = newPresets;
                let valToSelect = document.getElementById('presetSelect').value;
                if (pendingPresetSelection) { valToSelect = pendingPresetSelection; pendingPresetSelection = null; }
                updatePresetDropdown(valToSelect);
            }, (error) => {});
        }

        function loadLocalPresets() {
            try {
                const saved = localStorage.getItem('lydlab_presets');
                if (saved) userPresets = JSON.parse(saved); else userPresets = {};
                updatePresetDropdown();
            } catch (e) { userPresets = {}; }
        }

        function setLocalStorageMode() {
            const statusTxt = document.getElementById('cloudStatusText');
            if (statusTxt) statusTxt.textContent = "Lokal lagring";
            
            const ind = document.getElementById('cloudIndicator');
            if (ind) {
                ind.classList.remove("connected");
                ind.classList.add("local-storage");
            }
            
            const saveBtn = document.getElementById('savePresetBtn');
            const expBtn = document.getElementById('expertToggleBtn');
            if (saveBtn) saveBtn.disabled = false;
            if (expBtn) expBtn.disabled = false;
            
            try {
                const savedExpertMode = localStorage.getItem('lydlab_expertMode');
                if (savedExpertMode !== null) setExpertMode(savedExpertMode === 'true', true);
                const savedVol = localStorage.getItem('lydlab_masterVolume');
                if (savedVol !== null) updateGlobalVolumeUI(parseFloat(savedVol), true);
                else updateGlobalVolumeUI(0.8, true);
            } catch(e) {}
            
            loadLocalPresets();
        }

        function setOfflineMode() {
            const statusTxt = document.getElementById('cloudStatusText');
            if (statusTxt) statusTxt.textContent = "Lokal modus (Frakoblet)";
            
            const ind = document.getElementById('cloudIndicator');
            if (ind) {
                ind.style.backgroundColor = "#95a5a6";
                ind.classList.remove("connected");
                ind.classList.remove("local-storage");
            }
            
            const saveBtn = document.getElementById('savePresetBtn');
            const expBtn = document.getElementById('expertToggleBtn');
            if (saveBtn) saveBtn.disabled = false;
            if (expBtn) expBtn.disabled = false;
            
            updateGlobalVolumeUI(0.8, true);
        }

        function fallbackToLocal() {
            if (isLocalStorageAvailable()) {
                storageMode = 'local';
                setLocalStorageMode();
            } else {
                storageMode = 'none';
                setOfflineMode();
            }
        }

        async function initAuth() {
            try {
                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    await signInWithCustomToken(auth, __initial_auth_token);
                } else {
                    await signInAnonymously(auth);
                }
            } catch (error) {
                fallbackToLocal();
            }
        }

        function startApp() {
            if (typeof __firebase_config !== 'undefined' && initializeApp) {
                storageMode = 'cloud';
                try {
                    const config = JSON.parse(__firebase_config);
                    app = initializeApp(config);
                    auth = getAuth(app);
                    db = getFirestore(app);
                    
                    onAuthStateChanged(auth, async (user) => {
                        currentUser = user;
                        if (user && storageMode === 'cloud') {
                            const statusTxt = document.getElementById('cloudStatusText');
                            if (statusTxt) statusTxt.textContent = "Tilkoblet skyen";
                            
                            const ind = document.getElementById('cloudIndicator');
                            if (ind) {
                                ind.classList.add("connected");
                                ind.classList.remove("local-storage");
                            }
                            
                            const saveBtn = document.getElementById('savePresetBtn');
                            const expBtn = document.getElementById('expertToggleBtn');
                            if (saveBtn) saveBtn.disabled = false;
                            if (expBtn) expBtn.disabled = false;
                            
                            await fetchSettings(); 
                            setupPresetsListener();
                            authInitialized = true;
                        } else {
                            if (unsubscribePresets) unsubscribePresets();
                            if (storageMode === 'cloud') {
                                const saveBtn = document.getElementById('savePresetBtn');
                                if (saveBtn) saveBtn.disabled = true;
                            }
                            if (authInitialized) updateGlobalVolumeUI(0.8, true);
                        }
                    });

                    initAuth();
                } catch(error) {
                    fallbackToLocal();
                }
            } else {
                fallbackToLocal();
            }

            Promise.all([loadFactoryPresets(), loadExternalPresets()]).then(() => {
                drawVisualsStatic(); 
                drawADSR();
                const selectEl = document.getElementById('presetSelect');
                if(selectEl && selectEl.options.length > 0) { 
                    selectEl.dispatchEvent(new Event('change')); 
                }
            });
            
            setTimeout(() => {
                const controls = document.getElementById('masterVolControls');
                if (controls && controls.style.display === 'none') {
                    isAuthenticating = false;
                    updateGlobalVolumeUI(globalVolumeAmount, true);
                }
            }, 3000);
        }

        // ==========================================
        // 7. PIANO, KEYBOARD OG MIDI
        // ==========================================
        const keyMap = {};
        let activePcKeys = {};
        const pianoScrollWrapper = document.getElementById('pianoScrollWrapper');
        const pianoContainer = document.getElementById('pianoContainer');

        const pianoLayout = [
            { white: { note: 'C3', key: null, freq: 130.81 }, black: { note: 'C#3', key: null, freq: 138.59 } },
            { white: { note: 'D3', key: null, freq: 146.83 }, black: { note: 'D#3', key: null, freq: 155.56 } },
            { white: { note: 'E3', key: null, freq: 164.81 }, black: null },
            { white: { note: 'F3', key: null, freq: 174.61 }, black: { note: 'F#3', key: null, freq: 185.00 } },
            { white: { note: 'G3', key: null, freq: 196.00 }, black: { note: 'G#3', key: null, freq: 207.65 } },
            { white: { note: 'A3', key: null, freq: 220.00 }, black: { note: 'A#3', key: null, freq: 233.08 } },
            { white: { note: 'B3', key: null, freq: 246.94 }, black: null },
            { white: { note: 'C4', key: 'a', freq: 261.63 }, black: { note: 'C#4', key: 'w', freq: 277.18 } },
            { white: { note: 'D4', key: 's', freq: 293.66 }, black: { note: 'D#4', key: 'e', freq: 311.13 } },
            { white: { note: 'E4', key: 'd', freq: 329.63 }, black: null },
            { white: { note: 'F4', key: 'f', freq: 349.23 }, black: { note: 'F#4', key: 't', freq: 369.99 } },
            { white: { note: 'G4', key: 'g', freq: 392.00 }, black: { note: 'G#4', key: 'y', freq: 415.30 } },
            { white: { note: 'A4', key: 'h', freq: 440.00 }, black: { note: 'A#4', key: 'u', freq: 466.16 } },
            { white: { note: 'B4', key: 'j', freq: 493.88 }, black: null },
            { white: { note: 'C5', key: 'k', freq: 523.25 }, black: { note: 'C#5', key: 'o', freq: 554.37 } },
            { white: { note: 'D5', key: 'l', freq: 587.33 }, black: { note: 'D#5', key: 'p', freq: 622.25 } },
            { white: { note: 'E5', key: 'ø', freq: 659.25 }, black: null },
            { white: { note: 'F5', key: 'æ', freq: 698.46 }, black: { note: 'F#5', key: null, freq: 739.99 } },
            { white: { note: 'G5', key: null, freq: 783.99 }, black: { note: 'G#5', key: null, freq: 830.61 } },
            { white: { note: 'A5', key: null, freq: 880.00 }, black: { note: 'A#5', key: null, freq: 932.33 } },
            { white: { note: 'B5', key: null, freq: 987.77 }, black: null },
            { white: { note: 'C6', key: null, freq: 1046.50 }, black: null }
        ];

        if (pianoScrollWrapper) {
            pianoLayout.forEach(group => {
                const groupEl = document.createElement('div');
                groupEl.className = 'key-group';

                const whiteEl = document.createElement('div');
                whiteEl.className = 'white-key';
                whiteEl.setAttribute('data-freq', group.white.freq);
                whiteEl.setAttribute('data-note', group.white.note);
                if (group.white.key) keyMap[group.white.key] = { note: group.white.note, freq: group.white.freq };

                whiteEl.addEventListener('mousedown', (e) => { e.preventDefault(); triggerNotePress(group.white.freq, group.white.note); });
                whiteEl.addEventListener('mouseup', (e) => { e.preventDefault(); triggerNoteRelease(group.white.note); });
                whiteEl.addEventListener('mouseleave', (e) => { e.preventDefault(); triggerNoteRelease(group.white.note); });
                whiteEl.addEventListener('touchstart', (e) => { e.preventDefault(); triggerNotePress(group.white.freq, group.white.note); });
                whiteEl.addEventListener('touchend', (e) => { e.preventDefault(); triggerNoteRelease(group.white.note); });
                groupEl.appendChild(whiteEl);

                if (group.black) {
                    const blackEl = document.createElement('div');
                    blackEl.className = 'black-key';
                    blackEl.setAttribute('data-freq', group.black.freq);
                    blackEl.setAttribute('data-note', group.black.note);
                    if (group.black.key) keyMap[group.black.key] = { note: group.black.note, freq: group.black.freq };

                    blackEl.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); triggerNotePress(group.black.freq, group.black.note); });
                    blackEl.addEventListener('mouseup', (e) => { e.preventDefault(); e.stopPropagation(); triggerNoteRelease(group.black.note); });
                    blackEl.addEventListener('mouseleave', (e) => { e.preventDefault(); e.stopPropagation(); triggerNoteRelease(group.black.note); });
                    blackEl.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); triggerNotePress(group.black.freq, group.black.note); });
                    blackEl.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); triggerNoteRelease(group.black.note); });
                    groupEl.appendChild(blackEl);
                }
                pianoScrollWrapper.appendChild(groupEl);
            });
        }

        function getShiftedNoteName(noteStr, shift) {
            let match = noteStr.match(/([A-G]#?)(\d)/);
            if (!match) return noteStr;
            return match[1] + (parseInt(match[2]) + shift);
        }

        function renderPianoLabels() {
            document.querySelectorAll('.white-key, .black-key').forEach(el => {
                let note = el.getAttribute('data-note');
                if (displayMode === 'notes') {
                    el.textContent = note;
                    el.style.color = '';
                } else {
                    if (note && note.startsWith('C') && note.length === 2 && el.classList.contains('white-key')) {
                        el.textContent = note; el.style.color = '#aaa';
                    } else {
                        el.textContent = ''; el.style.color = '';
                    }
                }
            });

            if (displayMode === 'pc') {
                for (let key in keyMap) {
                    let baseNote = keyMap[key].note;
                    let shiftedNote = getShiftedNoteName(baseNote, pcOctaveShift);
                    let targetEl = document.querySelector(`[data-note="${shiftedNote}"]`);
                    if (targetEl) { targetEl.textContent = key.toUpperCase(); targetEl.style.color = ''; }
                }
            }

            let centerC = getShiftedNoteName('C4', pcOctaveShift);
            let centerCEl = document.querySelector(`[data-note="${centerC}"]`);
            if (centerCEl && pianoContainer) {
                pianoContainer.scrollTo({ left: centerCEl.parentElement.offsetLeft - 30, behavior: 'smooth' });
            }
        }

        function triggerNotePress(freq, noteId, velocity = 100) {
            activeNotes = activeNotes.filter(n => n.id !== noteId);
            activeNotes.push({ id: noteId, freq: freq });
            fundamentalFreq = freq;
            const tfv = document.getElementById('toolbarFreqVal');
            if (tfv) tfv.textContent = freq.toFixed(1) + " Hz";

            let keyEl = document.querySelector(`[data-note="${noteId}"]`);
            if (keyEl) keyEl.classList.add('active');

            if (isPolyphonic) {
                if(activeVoices[noteId]) stopVoice(noteId, true); 
                startVoice(freq, noteId, velocity); 
            } else {
                if (activeNotes.length === 1) {
                    startVoice(freq, 'mono', velocity);
                } else {
                    let monoVoice = activeVoices['mono'];
                    if (monoVoice && monoVoice.osc) {
                        monoVoice.osc.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.02);
                    }
                }
            }
        }

        function triggerNoteRelease(noteId) {
            activeNotes = activeNotes.filter(n => n.id !== noteId);
            let keyEl = document.querySelector(`[data-note="${noteId}"]`);
            if (keyEl) keyEl.classList.remove('active');

            if (isPolyphonic) {
                stopVoice(noteId);
            } else {
                if (activeNotes.length > 0) {
                    let lastNote = activeNotes[activeNotes.length - 1];
                    fundamentalFreq = lastNote.freq;
                    const tfv = document.getElementById('toolbarFreqVal');
                    if (tfv) tfv.textContent = fundamentalFreq.toFixed(1) + " Hz";
                    
                    let monoVoice = activeVoices['mono'];
                    if (monoVoice && monoVoice.osc) {
                        monoVoice.osc.frequency.setTargetAtTime(fundamentalFreq, audioCtx.currentTime, 0.02);
                    }
                } else {
                    stopVoice('mono');
                }
            }
        }

        const polyToggleBtn = document.getElementById('polyToggleBtn');
        if (polyToggleBtn) {
            polyToggleBtn.addEventListener('click', (e) => {
                isPolyphonic = !isPolyphonic;
                if (isPolyphonic) {
                    e.target.textContent = 'Polyfoni: PÅ';
                    e.target.style.backgroundColor = 'var(--accent)';
                    e.target.style.color = '#111';
                    e.target.style.borderColor = 'var(--accent)';
                } else {
                    e.target.textContent = 'Polyfoni: AV';
                    e.target.style.backgroundColor = '#222';
                    e.target.style.color = 'var(--text-main)';
                    e.target.style.borderColor = '#444';
                }
                for (let vid in activeVoices) { stopVoice(vid, true); }
                activeNotes = [];
                document.querySelectorAll('.white-key, .black-key').forEach(el => el.classList.remove('active'));
            });
        }

        const toggleLabelsBtn = document.getElementById('toggleLabelsBtn');
        if (toggleLabelsBtn) {
            toggleLabelsBtn.addEventListener('click', (e) => {
                if (displayMode === 'pc') {
                    displayMode = 'notes';
                    e.target.textContent = 'Vis PC-taster';
                } else {
                    displayMode = 'pc';
                    e.target.textContent = 'Vis Notenavn';
                }
                renderPianoLabels();
            });
        }

        const octDownBtn = document.getElementById('octDownBtn');
        if (octDownBtn) {
            octDownBtn.addEventListener('click', () => {
                pcOctaveShift = Math.max(-1, pcOctaveShift - 1);
                const disp = document.getElementById('octaveDisplay');
                if(disp) disp.textContent = pcOctaveShift > 0 ? "+" + pcOctaveShift : pcOctaveShift;
                renderPianoLabels();
            });
        }

        const octUpBtn = document.getElementById('octUpBtn');
        if (octUpBtn) {
            octUpBtn.addEventListener('click', () => {
                pcOctaveShift = Math.min(1, pcOctaveShift + 1);
                const disp = document.getElementById('octaveDisplay');
                if(disp) disp.textContent = pcOctaveShift > 0 ? "+" + pcOctaveShift : pcOctaveShift;
                renderPianoLabels();
            });
        }

        let presetScrollThrottle = false;

        window.addEventListener('keydown', (e) => {
            const targetTag = e.target.tagName.toLowerCase();
            if (targetTag === 'input' && e.target.type === 'text') return;
            if (targetTag === 'textarea') return;
            
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault(); 
                if (e.repeat && presetScrollThrottle) return;
                
                presetScrollThrottle = true;
                setTimeout(() => presetScrollThrottle = false, 150);

                const select = document.getElementById('presetSelect');
                if (select && select.options.length > 0) {
                    let newIndex = select.selectedIndex;
                    if (e.key === 'ArrowDown') newIndex = Math.min(newIndex + 1, select.options.length - 1);
                    else newIndex = Math.max(newIndex - 1, 0);
                    if (newIndex !== select.selectedIndex) {
                        select.selectedIndex = newIndex;
                        select.dispatchEvent(new Event('change'));
                    }
                }
                return;
            }

            if (e.key === 'ArrowLeft') {
                e.preventDefault(); 
                if (!e.repeat) {
                    const btn = document.getElementById('octDownBtn');
                    if (btn) btn.click();
                }
                return;
            }
            if (e.key === 'ArrowRight') {
                e.preventDefault(); 
                if (!e.repeat) {
                    const btn = document.getElementById('octUpBtn');
                    if (btn) btn.click();
                }
                return;
            }
            
            if (e.repeat) return;
            
            const key = e.key.toLowerCase();
            if (keyMap[key]) {
                let targetNote = getShiftedNoteName(keyMap[key].note, pcOctaveShift);
                let targetFreq = keyMap[key].freq * Math.pow(2, pcOctaveShift);
                activePcKeys[key] = { note: targetNote, freq: targetFreq };
                triggerNotePress(targetFreq, targetNote);
            }
        });

        window.addEventListener('keyup', (e) => {
            const targetTag = e.target.tagName.toLowerCase();
            if (targetTag === 'input' && e.target.type === 'text') return;
            if (targetTag === 'textarea') return;
            const key = e.key.toLowerCase();
            if (activePcKeys[key]) { triggerNoteRelease(activePcKeys[key].note); delete activePcKeys[key]; }
        });

        const midiStatusLight = document.getElementById('midiStatusLight');
        const activeMidiNotes = {};
        let isSustainActive = false;
        const sustainedNotes = new Set();
        if (navigator.requestMIDIAccess) {
            try {
                navigator.requestMIDIAccess()
                    .then(onMIDISuccess, onMIDIFailure)
                    .catch(err => {
                        console.warn("MIDI ble blokkert:", err);
                        onMIDIFailure();
                    });
            } catch (err) {
                onMIDIFailure();
            }
        } else {
            if (midiStatusLight) midiStatusLight.title = "MIDI ikke støttet i denne nettleseren";
        }

        function onMIDISuccess(midiAccess) {
            if (!midiStatusLight) return;
            midiStatusLight.title = "Klar. Venter på tilkobling...";
            const inputs = midiAccess.inputs.values();
            for (let input = inputs.next(); input && !input.done; input = inputs.next()) {
                input.value.onmidimessage = onMIDIMessage;
                midiStatusLight.title = "Tilkoblet: " + input.value.name;
                midiStatusLight.classList.add("active");
            }

            midiAccess.onstatechange = (e) => {
                if (e.port.type === "input") {
                    if (e.port.state === "connected") {
                        e.port.onmidimessage = onMIDIMessage;
                        midiStatusLight.title = "Tilkoblet: " + e.port.name;
                        midiStatusLight.classList.add("active");
                    } else {
                        midiStatusLight.title = "Frakoblet";
                        midiStatusLight.classList.remove("active");
                    }
                }
            };
        }

        function onMIDIFailure() {
            if (midiStatusLight) {
                midiStatusLight.title = "MIDI-tilgang nektet / Ikke tilgjengelig";
                midiStatusLight.classList.remove("active");
            }
        }

        function onMIDIMessage(event) {
            if (event.data.length < 3) return;
            const command = event.data[0];
            const note = event.data[1];
            const velocity = event.data[2];
            const status = command & 0xf0;

            if (status === 176 && note === 64) {
                isSustainActive = (velocity >= 64);
                if (!isSustainActive) {
                    for (let n of sustainedNotes) {
                        triggerNoteRelease(n);
                    }
                    sustainedNotes.clear();
                }
                return;
            }

            const isNoteOn = status === 144 && velocity > 0;
            const isNoteOff = status === 128 || (status === 144 && velocity === 0);

            if (isNoteOn) {
                // VISUELL OPPDATERING: Kjører alltid uansett lyd-status!
                playMidiNote(note, velocity);

                // LYD-SJEKK: Hvis lydmotoren fortsatt sover, si ifra til brukeren
                if (audioCtx && audioCtx.state === 'suspended') {
                    showErrorBanner("🔇 Lydmotoren sover. Klikk én gang på siden med musen for å vekke den!");
                } else {
                    const errBanner = document.getElementById('urlErrorBanner');
                    if (errBanner && errBanner.textContent.includes('sover')) errBanner.style.display = 'none';
                }
            } else if (isNoteOff) {
                releaseMidiNote(note);
            }
        }

        function playMidiNote(note, velocity) {
            const freq = 440 * Math.pow(2, (note - 69) / 12);
            const noteId = 'M' + note;
            activeMidiNotes[note] = noteId;

            let visualNoteStr = null;
            if (note >= 48 && note <= 84) {
                const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
                const octave = Math.floor(note / 12) - 1;
                visualNoteStr = noteNames[note % 12] + octave;
            }
            const finalNoteId = visualNoteStr || noteId;
            if (sustainedNotes.has(finalNoteId)) {
                sustainedNotes.delete(finalNoteId);
            }
            triggerNotePress(freq, finalNoteId, velocity);
        }

        function releaseMidiNote(note) {
            const noteId = activeMidiNotes[note];
            if (noteId) {
                let visualNoteStr = null;
                if (note >= 48 && note <= 84) {
                    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
                    const octave = Math.floor(note / 12) - 1;
                    visualNoteStr = noteNames[note % 12] + octave;
                }
                const finalNoteId = visualNoteStr || noteId;
                
                let keyEl = document.querySelector(`[data-note="${finalNoteId}"]`);
                if (keyEl) keyEl.classList.remove('active');

                if (isSustainActive) {
                    sustainedNotes.add(finalNoteId);
                } else {
                    triggerNoteRelease(finalNoteId);
                }
                delete activeMidiNotes[note];
            }
        }

        // ==========================================
        // 8. EVENT LISTENERS FOR UI SLIDERS
        // ==========================================
        const globalMasterVolSlider = document.getElementById('globalMasterVol');
        if (globalMasterVolSlider) {
            globalMasterVolSlider.addEventListener('input', (e) => {
                updateGlobalVolumeUI(parseFloat(e.target.value) / 100, false);
            });
        }

        const drawbarsContainerInit = document.getElementById('drawbarsContainer');
        if (drawbarsContainerInit) {
            drawbarsContainerInit.innerHTML = '';
            for (let i = 1; i <= MANUAL_HARMONICS_COUNT; i++) {
                const wrapper = document.createElement('div'); wrapper.className = 'drawbar-wrapper';
                const slider = document.createElement('input'); 
                slider.type = 'range'; slider.id = 'drawbar_' + i; slider.min = '0'; slider.max = '1'; slider.step = '0.01'; slider.value = i === 1 ? '1' : '0';
                slider.addEventListener('input', (e) => {
                    manualHarmonics[i] = parseFloat(e.target.value);
                    if (!isSounding) drawVisualsStatic();
                    if (isPlaying) updateAudioWaveform();
                });
                const label = document.createElement('div'); label.className = 'drawbar-label';
                label.innerHTML = i === 1 ? '<span style="color:var(--sine-color)">1x</span>' : i + 'x';
                wrapper.appendChild(slider); wrapper.appendChild(label);
                drawbarsContainerInit.appendChild(wrapper);
            }
        }

        document.querySelectorAll('.wave-btn').forEach(btn => btn.addEventListener('click', (e) => {
            if(e.target.dataset.wave === 'manual' && !document.body.classList.contains('expert-mode')) return;
            document.querySelectorAll('.wave-btn').forEach(b => b.classList.remove('active')); e.target.classList.add('active');
            currentWave = e.target.dataset.wave; 
            const infoTextEl = document.getElementById('infoText');
            if(infoTextEl) infoTextEl.innerHTML = explanations[currentWave];
            
            const autoH = document.getElementById('autoHarmonicsGroup'); const manH = document.getElementById('manualHarmonicsGroup');
            if(autoH) autoH.style.display = currentWave === 'manual' ? 'none' : 'flex';
            if(manH) manH.style.display = currentWave === 'manual' ? 'flex' : 'none';
            if (!isSounding) drawVisualsStatic(); if (isPlaying) updateAudioWaveform();
        }));

        const harmSlider = document.getElementById('harmonicsSlider');
        if (harmSlider) {
            harmSlider.addEventListener('input', (e) => { numHarmonics = parseInt(e.target.value); const harmVal = document.getElementById('harmonicsVal'); if (harmVal) harmVal.textContent = numHarmonics; if (!isSounding) drawVisualsStatic(); if (isPlaying) updateAudioWaveform(); });
        }

        const oscMixSlider = document.getElementById('oscMix');
        if (oscMixSlider) {
            oscMixSlider.addEventListener('input', (e) => {
                oscAmount = parseFloat(e.target.value) / 100;
                const oscVolVal = document.getElementById('oscVolVal'); if (oscVolVal) oscVolVal.textContent = e.target.value + " %";
                if (audioCtx) {
                    for (let vid in activeVoices) {
                        if (activeVoices[vid].oscGain) activeVoices[vid].oscGain.gain.setTargetAtTime(oscAmount, audioCtx.currentTime, 0.05);
                    }
                }
                if (!isSounding) drawVisualsStatic();
            });
        }
        
        const noiseMixSlider = document.getElementById('noiseMix');
        if (noiseMixSlider) {
            noiseMixSlider.addEventListener('input', (e) => {
                noiseAmount = parseFloat(e.target.value) / 100;
                const noiseVal = document.getElementById('noiseVal'); if (noiseVal) noiseVal.textContent = e.target.value + " %";
                if (audioCtx) {
                    for (let vid in activeVoices) {
                        if (activeVoices[vid].nGain) activeVoices[vid].nGain.gain.setTargetAtTime(noiseAmount * 0.5, audioCtx.currentTime, 0.05);
                    }
                }
                if (!isSounding) drawVisualsStatic();
            });
        }

        const cutoffSlider = document.getElementById('cutoff');
        if (cutoffSlider) {
            cutoffSlider.addEventListener('input', (e) => { 
                lpFilterCutoff = parseFloat(e.target.value); 
                const cutoffVal = document.getElementById('cutoffVal');
                if (cutoffVal) cutoffVal.textContent = lpFilterCutoff >= 1000 ? (lpFilterCutoff / 1000).toFixed(1) + " kHz" : Math.round(lpFilterCutoff) + " Hz"; 
                if (lpFilterNode && audioCtx) lpFilterNode.frequency.setTargetAtTime(lpFilterCutoff, audioCtx.currentTime, 0.05); 
                if (!isSounding) drawVisualsStatic(); 
            });
        }

        const hpCutoffSlider = document.getElementById('hpCutoff');
        if (hpCutoffSlider) {
            hpCutoffSlider.addEventListener('input', (e) => { 
                hpFilterCutoff = parseFloat(e.target.value); 
                const hpCutoffVal = document.getElementById('hpCutoffVal');
                if (hpCutoffVal) hpCutoffVal.textContent = hpFilterCutoff >= 1000 ? (hpFilterCutoff / 1000).toFixed(1) + " kHz" : Math.round(hpFilterCutoff) + " Hz"; 
                if (hpFilterNode && audioCtx) hpFilterNode.frequency.setTargetAtTime(hpFilterCutoff, audioCtx.currentTime, 0.05); 
                if (!isSounding) drawVisualsStatic(); 
            });
        }

        ['a', 'd', 's', 'r'].forEach(p => {
            const envSlider = document.getElementById('env' + p.toUpperCase());
            if (envSlider) {
                envSlider.addEventListener('input', (e) => { adsr[p] = parseFloat(e.target.value); const envVal = document.getElementById('val' + p.toUpperCase()); if (envVal) envVal.textContent = p === 's' ? Math.round(adsr[p] * 100) + ' %' : adsr[p].toFixed(2) + ' s'; drawADSR(); });
            }
        });

        const lfoRateSlider = document.getElementById('lfoRate');
        if (lfoRateSlider) lfoRateSlider.addEventListener('input', (e) => { lfo.rate = 0.1 * Math.pow(2000 / 0.1, parseFloat(e.target.value) / 100); const valLfoRate = document.getElementById('valLfoRate'); if (valLfoRate) valLfoRate.textContent = lfo.rate >= 1000 ? (lfo.rate / 1000).toFixed(2) + " kHz" : (lfo.rate >= 10 ? Math.round(lfo.rate) : lfo.rate.toFixed(1)) + " Hz"; updateLFO(); if (!isSounding) drawVisualsStatic(); });
        
        const lfoVibratoSlider = document.getElementById('lfoVibrato');
        if (lfoVibratoSlider) lfoVibratoSlider.addEventListener('input', (e) => { lfo.vibrato = parseFloat(e.target.value) * 5; const valLfoVibrato = document.getElementById('valLfoVibrato'); if (valLfoVibrato) valLfoVibrato.textContent = e.target.value + " %"; updateLFO(); if (!isSounding) drawVisualsStatic(); });
        
        const lfoTremoloSlider = document.getElementById('lfoTremolo');
        if (lfoTremoloSlider) lfoTremoloSlider.addEventListener('input', (e) => { lfo.tremolo = parseFloat(e.target.value) / 100; const valLfoTremolo = document.getElementById('valLfoTremolo'); if(valLfoTremolo) valLfoTremolo.textContent = e.target.value + " %"; updateLFO(); if (!isSounding) drawVisualsStatic(); });
        
        const lfoFilterSlider = document.getElementById('lfoFilter');
        if (lfoFilterSlider) lfoFilterSlider.addEventListener('input', (e) => { lfo.filterMod = parseFloat(e.target.value) * 48; const valLfoFilter = document.getElementById('valLfoFilter'); if (valLfoFilter) valLfoFilter.textContent = e.target.value + " %"; updateLFO(); if (!isSounding) drawVisualsStatic(); });

        const delayTimeSlider = document.getElementById('delayTime');
        if (delayTimeSlider) delayTimeSlider.addEventListener('input', (e) => { delayConfig.time = parseFloat(e.target.value); const valDelayTime = document.getElementById('valDelayTime'); if(valDelayTime) valDelayTime.textContent = delayConfig.time.toFixed(2) + " s"; if (delayNode && audioCtx) delayNode.delayTime.setTargetAtTime(delayConfig.time, audioCtx.currentTime, 0.01); });
        
        const delayFeedbackSlider = document.getElementById('delayFeedback');
        if (delayFeedbackSlider) delayFeedbackSlider.addEventListener('input', (e) => { delayConfig.feedback = parseFloat(e.target.value) / 100; const valDelayFeedback = document.getElementById('valDelayFeedback'); if (valDelayFeedback) valDelayFeedback.textContent = e.target.value + " %"; if (delayFeedbackGain && audioCtx) delayFeedbackGain.gain.setTargetAtTime(delayConfig.feedback, audioCtx.currentTime, 0.01); });
        
        const delayMixSlider = document.getElementById('delayMix');
        if (delayMixSlider) delayMixSlider.addEventListener('input', (e) => { delayConfig.mix = parseFloat(e.target.value) / 100; const valDelayMix = document.getElementById('valDelayMix'); if (valDelayMix) valDelayMix.textContent = e.target.value + " %"; if (delayMixGain && audioCtx) delayMixGain.gain.setTargetAtTime(delayConfig.mix, audioCtx.currentTime, 0.01); });
        
        const reverbTimeSlider = document.getElementById('reverbTime');
        if (reverbTimeSlider) reverbTimeSlider.addEventListener('input', (e) => { reverbConfig.time = parseFloat(e.target.value); const valReverbTime = document.getElementById('valReverbTime'); if(valReverbTime) valReverbTime.textContent = reverbConfig.time.toFixed(1) + " s"; if (convolverNode && audioCtx && typeof createReverbBuffer === 'function') convolverNode.buffer = createReverbBuffer(audioCtx, reverbConfig.time); });
        
        const reverbMixSlider = document.getElementById('reverbMix');
        if (reverbMixSlider) reverbMixSlider.addEventListener('input', (e) => { reverbConfig.mix = parseFloat(e.target.value) / 100; const valReverbMix = document.getElementById('valReverbMix'); if(valReverbMix) valReverbMix.textContent = e.target.value + " %"; if (reverbMixGain && audioCtx) reverbMixGain.gain.setTargetAtTime(reverbConfig.mix, audioCtx.currentTime, 0.01); });

        const expertToggleBtnRef = document.getElementById('expertToggleBtn');
        if(expertToggleBtnRef) expertToggleBtnRef.addEventListener('click', () => { setExpertMode(!document.body.classList.contains('expert-mode')); });

        // ==========================================
        // 9. OPPSTART
        // ==========================================
        let hasUnlockedAudio = false;

        function unlockAudioContext() {
            if (!audioCtx) initAudio();
            
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume().then(() => {
                    hasUnlockedAudio = true;
                    const errBanner = document.getElementById('urlErrorBanner');
                    if (errBanner && errBanner.textContent.includes('sover')) errBanner.style.display = 'none';
                }).catch(e => {});
            } else {
                hasUnlockedAudio = true;
            }
            window.removeEventListener('mousedown', unlockAudioContext);
            window.removeEventListener('keydown', unlockAudioContext);
            window.removeEventListener('touchstart', unlockAudioContext);
        }
        
        window.addEventListener('mousedown', unlockAudioContext);
        window.addEventListener('keydown', unlockAudioContext);
        window.addEventListener('touchstart', unlockAudioContext);

        window.addEventListener('resize', () => { drawVisualsStatic(); drawADSR(); });
        renderPianoLabels();
        
        if (typeof app !== 'undefined' && app && auth) {
             initAuth();
        } else {
             startApp();
        }
        
