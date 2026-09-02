import { apiUrl as buildApiUrl } from './apiClient.js';

const DEFAULT_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

export class DeepgramVoice {
  constructor({ onTranscript = () => {}, onStatus = () => {}, apiUrl: endpoint = buildApiUrl('/api/deepgram/transcribe') } = {}) {
    this.onTranscript = onTranscript;
    this.onStatus = onStatus;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.listening = false;
    this.apiUrl = endpoint;
    this.audioContext = null;
    this.analyser = null;
    this.silenceFrame = null;
    this.speechStartedAt = 0;
  }

  async toggle() {
    if (this.listening) {
      await this.stop();
      return false;
    }
    await this.start();
    return true;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support microphone capture.');
    }
    if (!globalThis.MediaRecorder) {
      throw new Error('This browser does not support voice recording.');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const supportsMime = typeof MediaRecorder.isTypeSupported === 'function'
      ? (type) => MediaRecorder.isTypeSupported(type)
      : () => false;
    const mimeType = DEFAULT_MIME_TYPES.find(supportsMime);
    this.recorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);
    this.chunks = [];
    this.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size) this.chunks.push(event.data);
    });
    this.recorder.addEventListener('error', (event) => {
      const message = event.error?.message || 'The microphone recorder failed.';
      this.onStatus({ state: 'error', message });
    });
    // Collect the complete clip and let stop() emit one final dataavailable
    // event. This is more reliable for short recordings across browsers than
    // relying on timeslice events (some Safari versions omit them).
    this.recorder.start();
    this.listening = true;
    this.startSilenceMonitor();
    this.onStatus({ state: 'listening', message: 'RECORDING… PRESS STOP TO SEND' });
  }

  startSilenceMonitor() {
    try {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return;
      this.audioContext = new AudioContextClass();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.audioContext.createMediaStreamSource(this.stream).connect(this.analyser);
      const samples = new Uint8Array(this.analyser.fftSize);
      const startedAt = Date.now();
      const check = () => {
        if (!this.listening || !this.analyser) return;
        this.analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          energy += normalized * normalized;
        }
        const speaking = Math.sqrt(energy / samples.length) > 0.035;
        if (speaking) this.speechStartedAt = Date.now();
        const silenceStarted = this.speechStartedAt || startedAt;
        const elapsed = Date.now() - silenceStarted;
        // Require a brief utterance, then stop after ~0.9s of silence.
        if (this.speechStartedAt && elapsed > 900 && Date.now() - startedAt > 700) {
          this.stop().catch((error) => this.onStatus({ state: 'error', message: error.message }));
          return;
        }
        this.silenceFrame = requestAnimationFrame(check);
      };
      this.silenceFrame = requestAnimationFrame(check);
    } catch {
      // Voice recording still works when Web Audio is unavailable.
      this.stopSilenceMonitor();
    }
  }

  stopSilenceMonitor() {
    if (this.silenceFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.silenceFrame);
    }
    this.silenceFrame = null;
    this.analyser = null;
    this.audioContext?.close?.().catch?.(() => {});
    this.audioContext = null;
    this.speechStartedAt = 0;
  }

  async stop() {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      this.cleanup();
      return;
    }
    this.listening = false;
    this.stopSilenceMonitor();
    // MediaRecorder emits its final `dataavailable` event as part of stop().
    // Wait for both events so short recordings are not uploaded as zero bytes.
    const stopped = new Promise((resolve) => {
      let stopSeen = false;
      let dataSeen = false;
      const finish = () => {
        if (stopSeen && dataSeen) queueMicrotask(resolve);
      };
      recorder.addEventListener('dataavailable', (event) => {
        dataSeen = dataSeen || Boolean(event.data?.size);
        finish();
      });
      recorder.addEventListener('stop', () => {
        stopSeen = true;
        finish();
      }, { once: true });
      // A broken recorder should not leave the voice button stuck forever.
      setTimeout(resolve, 1000);
    });
    recorder.stop();
    await stopped;
    if (!this.chunks.length) {
      this.cleanup();
      throw new Error('No audio was captured. Check microphone permission and try again.');
    }
    const audio = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
    this.stream?.getTracks().forEach((track) => track.stop());
    this.onStatus({ state: 'transcribing', message: 'TRANSCRIBING…' });
    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': audio.type },
        body: audio,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || `Transcription failed (${response.status}).`);
      }
      const transcript = payload.transcript?.trim();
      if (transcript) this.onTranscript(transcript);
      else throw new Error('No speech was detected.');
    } finally {
      this.cleanup();
      this.onStatus({ state: 'idle', message: 'VOICE READY' });
    }
  }

  cleanup() {
    this.stopSilenceMonitor();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    const wasListening = this.listening;
    this.listening = false;
    if (wasListening) this.onStatus({ state: 'idle', message: 'VOICE READY' });
  }

  destroy() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.listening = false;
    this.cleanup();
  }
}
