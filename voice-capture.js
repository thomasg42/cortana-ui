/* voice-capture.js — the phone's half of Cortana's open-mic loop.
 *
 * Safari on iOS ships webkitSpeechRecognition but ignores `continuous`, ends
 * the session after one phrase and refuses to restart outside a user gesture,
 * so mobile records real audio and the core transcribes it (/api/stt). That
 * recorder path used to decide "you stopped talking" purely from a WebAudio
 * analyser hung off the mic stream — and on a phone that analyser can come up
 * permanently silent (iOS suspends the AudioContext, and WebKit's
 * createMediaStreamSource can hand back a dead node when the context predates
 * the stream). Dead analyser meant `sawSpeech` was never true, so every clip
 * was recycled as "nobody talking" and NOTHING WAS EVER SENT: the mic glowed,
 * the phone recorded, and Cortana never heard a word. That is the bug this
 * module exists to make impossible.
 *
 * Three defences, in order:
 *   1. Detect it. A live microphone never reads *exactly* zero — even a silent
 *      room dithers. All-zero for ANALYSER_PROOF_MS means the graph is dead,
 *      not that the room is quiet.
 *   2. Repair it once. Rebuild the AudioContext and re-attach the analyser to
 *      the same stream (the documented WebKit workaround: context after stream).
 *   3. Stop depending on it. If the rebuild is still dead we switch to manual
 *      turns — the clip ends when Chief taps DONE. Slower, but it always works.
 *
 * The DONE control is offered on every recorder turn, not only the broken
 * ones, so a mis-tuned silence threshold can never again leave him with no way
 * to make the phone send what he just said.
 *
 * Extracted from index.html so it can be driven headlessly — there is no
 * working Chromium on the build machine (see reference note
 * no-chromium-cli-use-playwright), and a voice loop nobody can test is how the
 * silent-analyser failure survived in the first place.
 */
(function () {
  'use strict';

  const VAD_TICK_MS = 60;
  const VAD_SILENCE_MS = 1400;         // quiet this long after speech = turn over
  const VAD_MIN_SPEECH_MS = 250;       // a cough or a door is not a sentence
  const VAD_MAX_UTTERANCE_MS = 30000;  // hard cap so one clip can't grow unbounded
  const VAD_MAX_IDLE_MS = 15000;       // nobody talking — recycle the buffer
  const ANALYSER_PROOF_MS = 1200;      // all-zero this long = the analyser is dead
  const MANUAL_MAX_UTTERANCE_MS = 120000; // manual turns get a much longer leash
  const MIN_AUTO_BLOB = 1024;          // auto-sent clips must look like speech
  const MIN_FORCED_BLOB = 512;         // a deliberate DONE tap is trusted harder

  const MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2',
                 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/aac'];

  /* deps (every one injectable so tests can drive this without a browser):
       mediaDevices      – navigator.mediaDevices
       MediaRecorderCtor – window.MediaRecorder
       isTypeSupported   – MediaRecorder.isTypeSupported (optional)
       newAudioContext() – returns a FRESH AudioContext, or null if unavailable
       isActive()        – true while the conversation should still be listening
       onClip(blob)      – a finished utterance, ready for /api/stt
       onError(err)      – mic unavailable; err.denied marks a permission refusal
       onListening(on)   – recorder armed / stopped
       onSpeech()        – first voiced frame of this clip (analyser path only)
       onLevel(l, ok)    – per tick: rms 0..1, and whether the analyser is trusted
       onManualMode(why) – the analyser is unusable; the UI must offer DONE
       releaseAudioContext(ctx) – optional; the page disposes of the context it
                           gave us (it may be the shared TTS one, which must NOT be closed)
       scheduler         – { setInterval, clearInterval, now } (tests fake these)
  */
  window.createVoiceCapture = function createVoiceCapture(deps) {
    const d = deps || {};
    const sched = d.scheduler || { setInterval, clearInterval, now: () => Date.now() };
    const now = () => (sched.now ? sched.now() : Date.now());
    const emit = (name, ...args) => { if (typeof d[name] === 'function') { try { d[name](...args); } catch (_) {} } };
    const active = () => !!(d.isActive && d.isActive());

    let stream = null, recorder = null, chunks = [], timer = null;
    let analyser = null, analyserData = null, audioCtx = null;
    let capturing = false, sendOnStop = false, forcedSend = false;
    let noiseFloor = 0.004;
    let sawSpeech = false, voicedMs = 0, lastVoiceAt = 0, startedAt = 0;
    let analyserTrusted = false, analyserProbeStart = 0, repairTried = false;
    let manualMode = false, manualReason = '';

    function pickMime() {
      const supported = d.isTypeSupported;
      if (!d.MediaRecorderCtor || typeof supported !== 'function') return '';
      for (const type of MIMES) { if (supported(type)) return type; }
      return '';
    }

    /* Build (or rebuild) the level analyser on top of the live mic stream.
       Always makes a NEW AudioContext: on iOS a context created before
       getUserMedia can produce a permanently silent MediaStreamSource, and
       reusing the dead one is exactly the failure we are recovering from. */
    function attachAnalyser() {
      analyser = null; analyserData = null;
      if (!stream || typeof d.newAudioContext !== 'function') return false;
      try {
        const ctx = d.newAudioContext();
        if (!ctx) return false;
        audioCtx = ctx;
        if (ctx.state === 'suspended' && ctx.resume) { try { ctx.resume(); } catch (_) {} }
        const node = ctx.createAnalyser();
        node.fftSize = 1024;
        node.smoothingTimeConstant = 0.4;
        ctx.createMediaStreamSource(stream).connect(node);
        analyser = node;
        analyserData = new Uint8Array(node.fftSize);
        noiseFloor = 0.004;
        return true;
      } catch (_) {
        analyser = null; analyserData = null;
        return false;
      }
    }

    function level() {
      if (!analyser || !analyserData) return 0;
      try { analyser.getByteTimeDomainData(analyserData); } catch (_) { return 0; }
      let sum = 0;
      for (let i = 0; i < analyserData.length; i++) {
        const v = (analyserData[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / analyserData.length);
    }

    function goManual(reason) {
      if (manualMode) return;
      manualMode = true;
      manualReason = reason;
      analyserTrusted = false;
      emit('onManualMode', reason);
    }

    async function ensureStream() {
      if (stream && stream.getAudioTracks && stream.getAudioTracks().some((t) => t.readyState === 'live')) return stream;
      if (!d.mediaDevices || !d.mediaDevices.getUserMedia) {
        const err = new Error('This browser has no microphone API.');
        err.denied = false;
        throw err;
      }
      stream = await d.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      analyserTrusted = false; repairTried = false;
      if (!attachAnalyser()) goManual('no-audio-context');
      return stream;
    }

    /* Stop the current clip. `send` decides whether it becomes a message or is
       dropped and re-armed (silence, or a noise too short to be speech). */
    function endClip(send, forced) {
      sendOnStop = !!send;
      forcedSend = !!forced;
      sched.clearInterval(timer); timer = null;
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) {} return; }
      capturing = false;                        // recorder already gone — re-arm directly
      emit('onListening', false);
      if (active()) start();
    }

    function tick() {
      const t = now();
      const l = level();
      emit('onLevel', l, analyserTrusted);

      if (!analyserTrusted && !manualMode) {
        if (l > 0) {
          analyserTrusted = true;               // real data is flowing — normal VAD from here
        } else if (t - analyserProbeStart > ANALYSER_PROOF_MS) {
          /* A live mic never reads exactly zero, so this is a dead audio graph,
             not a quiet room. One rebuild attempt, then give up on it. */
          if (!repairTried) {
            repairTried = true;
            analyserProbeStart = t;
            if (!attachAnalyser()) goManual('analyser-rebuild-failed');
          } else {
            goManual('analyser-silent');
          }
        }
      }

      if (manualMode) {
        // Nothing auto-ends a manual turn but the hard cap — Chief taps DONE.
        if (t - startedAt > MANUAL_MAX_UTTERANCE_MS) endClip(true, true);
        return;
      }
      if (!analyserTrusted) return;             // still proving the analyser; don't judge silence

      const gate = Math.max(0.012, noiseFloor * 3.2);
      if (l > gate) {
        if (!sawSpeech) emit('onSpeech');
        sawSpeech = true;
        voicedMs += VAD_TICK_MS;
        lastVoiceAt = t;
      } else if (!sawSpeech) {
        noiseFloor = noiseFloor * 0.94 + l * 0.06;   // learn the room only while it's quiet
      }
      if (sawSpeech && t - lastVoiceAt > VAD_SILENCE_MS) { endClip(voicedMs >= VAD_MIN_SPEECH_MS); return; }
      if (sawSpeech && t - startedAt > VAD_MAX_UTTERANCE_MS) { endClip(true); return; }
      if (!sawSpeech && t - startedAt > VAD_MAX_IDLE_MS) endClip(false);
    }

    function start() {
      if (capturing || !active()) return;
      capturing = true;
      ensureStream().then(() => {
        if (!active()) { capturing = false; return; }
        const mime = pickMime();
        try {
          recorder = mime
            ? new d.MediaRecorderCtor(stream, { mimeType: mime, audioBitsPerSecond: 32000 })
            : new d.MediaRecorderCtor(stream);
        } catch (_) { recorder = new d.MediaRecorderCtor(stream); }
        chunks = []; sendOnStop = false; forcedSend = false;
        sawSpeech = false; voicedMs = 0; lastVoiceAt = 0;
        startedAt = now(); analyserProbeStart = startedAt;
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = () => {
          capturing = false;
          const type = (recorder && recorder.mimeType) || mime || 'audio/webm';
          const parts = chunks; chunks = []; recorder = null;
          const blob = parts.length ? new Blob(parts, { type }) : null;
          const floor = forcedSend ? MIN_FORCED_BLOB : MIN_AUTO_BLOB;
          emit('onListening', false);
          if (sendOnStop && blob && blob.size > floor) emit('onClip', blob);
          else if (active()) start();          // nothing worth sending — listen again
        };
        recorder.start();
        emit('onListening', true);
        sched.clearInterval(timer);
        timer = sched.setInterval(tick, VAD_TICK_MS);
      }).catch((err) => {
        capturing = false;
        sched.clearInterval(timer); timer = null;
        const denied = /NotAllowed|Permission|Security/i.test((err && err.name) + ' ' + (err && err.message));
        if (err) err.denied = 'denied' in err ? err.denied : denied;
        emit('onListening', false);
        emit('onError', err || new Error('Microphone unavailable'));
      });
    }

    function stop() {
      sched.clearInterval(timer); timer = null;
      sendOnStop = false; forcedSend = false;
      /* Let onstop clear `capturing` — flipping it here would let a resume that
         lands first build a second recorder on the same stream. */
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) {} return; }
      recorder = null; chunks = [];
      capturing = false;
      emit('onListening', false);
    }

    /* Chief tapped DONE: end this turn and send it, whatever the analyser
       thinks. The escape hatch that makes a mis-read microphone survivable. */
    function finishTurn() {
      if (!capturing) return false;
      if (!recorder || recorder.state === 'inactive') return false;
      endClip(true, true);
      return true;
    }

    /* Fully release the microphone — only when the conversation ends, so the
       permission prompt happens once per conversation, not once per turn. */
    function release() {
      stop();
      if (stream && stream.getTracks) {
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      }
      stream = null; analyser = null; analyserData = null;
      /* The page may have handed us a context it also uses for TTS playback —
         closing that one can never be undone and would leave Cortana mute — so
         releasing it is the page's call when it offers a releaser. */
      if (audioCtx) {
        if (typeof d.releaseAudioContext === 'function') emit('releaseAudioContext', audioCtx);
        else if (audioCtx.close) { try { audioCtx.close(); } catch (_) {} }
      }
      audioCtx = null;
    }

    return {
      start, stop, release, finishTurn,
      isCapturing: () => capturing,
      isManual: () => manualMode,
      manualReason: () => manualReason,
      analyserTrusted: () => analyserTrusted,
      constants: { VAD_TICK_MS, VAD_SILENCE_MS, ANALYSER_PROOF_MS, MANUAL_MAX_UTTERANCE_MS },
    };
  };
})();
