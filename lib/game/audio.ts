import type {
  AssetRef,
  CharacterDefinition,
  CombatEvent,
  RuntimeUnit,
  SoundCue,
} from "./types";

type OscillatorShape = OscillatorType;

export class ArenaAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private muted = false;
  private volume = 0.72;
  private lastPlayed = new Map<string, number>();
  private lastSpeechAt = 0;

  async unlock(): Promise<void> {
    if (typeof window === "undefined") return;
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      this.applyMasterVolume();
    }
    if (this.context.state === "suspended") await this.context.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted && typeof window !== "undefined") window.speechSynthesis?.cancel();
    this.applyMasterVolume();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyMasterVolume();
  }

  async playEvent(
    event: CombatEvent,
    units: RuntimeUnit[],
    definitions: CharacterDefinition[],
    assets: AssetRef[],
  ): Promise<void> {
    if (!event.sound || this.muted) return;
    const now = performance.now();
    const key = `${event.sound}-${event.unitId ?? "world"}`;
    if (now - (this.lastPlayed.get(key) ?? 0) < 36) return;
    this.lastPlayed.set(key, now);
    await this.unlock();

    const unit = units.find((candidate) => candidate.id === event.unitId);
    const definition = unit
      ? definitions.find((candidate) => candidate.id === unit.definitionId)
      : undefined;
    const slot =
      event.sound === "lava" || event.sound === "spring"
        ? undefined
        : event.type === "attack"
        ? "attack"
        : event.type === "damage"
          ? "hurt"
          : event.type === "death"
            ? "death"
            : event.type === "skill" || event.type === "spawn"
              ? "skill"
              : undefined;
    const cue = slot ? definition?.sounds[slot] : undefined;
    if (cue?.source === "asset" && cue.assetId) {
      const asset = assets.find((candidate) => candidate.id === cue.assetId);
      if (asset) {
        const audio = new Audio(asset.url);
        audio.volume = Math.min(1, this.volume * cue.volume);
        void audio.play().catch(() => undefined);
        return;
      }
    }
    if (cue?.source === "speech") {
      this.playSpeech(cue);
      return;
    }
    this.playSynth(cue ?? { id: event.sound, source: "synth", preset: event.sound, volume: 0.7 });
  }

  private playSpeech(cue: SoundCue): void {
    if (
      this.muted ||
      typeof window === "undefined" ||
      !window.speechSynthesis ||
      performance.now() - this.lastSpeechAt < 850
    ) {
      return;
    }
    const phrases = cue.phrases?.filter(Boolean) ?? [];
    if (!phrases.length) return;
    this.lastSpeechAt = performance.now();
    const utterance = new SpeechSynthesisUtterance(
      phrases[Math.floor(Math.random() * phrases.length)],
    );
    utterance.lang = "zh-CN";
    utterance.rate = cue.speechRate ?? 1;
    utterance.pitch = cue.speechPitch ?? 1;
    utterance.volume = Math.min(1, this.volume * cue.volume);
    const voice = window.speechSynthesis
      .getVoices()
      .find((candidate) => candidate.lang.toLowerCase().startsWith("zh"));
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }

  playSynth(cue: SoundCue): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master || this.muted) return;
    const preset = cue.preset ?? "swipe";
    const volume = cue.volume ?? 0.7;
    const randomPitch = 1 + (Math.random() * 2 - 1) * (cue.pitchVariance ?? 0.04);
    const now = context.currentTime;

    if (["swipe", "baton", "kick"].includes(preset)) {
      this.noiseBurst(now, preset === "swipe" ? 0.11 : 0.08, volume * 0.25, 1200, 160);
      if (preset !== "swipe") {
        this.tone(now + 0.015, preset === "kick" ? 110 : 180, 0.09, volume * 0.3, "square", 65);
      }
    } else if (preset === "pistol") {
      this.noiseBurst(now, 0.08, volume * 0.42, 2600, 180);
      this.tone(now, 190 * randomPitch, 0.07, volume * 0.25, "square", 80);
    } else if (preset === "rifle") {
      this.noiseBurst(now, 0.055, volume * 0.34, 3400, 260);
      this.tone(now, 155 * randomPitch, 0.06, volume * 0.2, "sawtooth", 70);
    } else if (preset === "rocket") {
      this.noiseBurst(now, 0.28, volume * 0.28, 850, 90);
      this.tone(now, 95, 0.3, volume * 0.2, "sawtooth", 50);
    } else if (preset === "explosion") {
      this.noiseBurst(now, 0.45, volume * 0.55, 700, 35);
      this.tone(now, 75, 0.35, volume * 0.35, "sine", 28);
    } else if (preset === "gatling") {
      this.noiseBurst(now, 0.045, volume * 0.28, 3000, 260);
      this.tone(now, 145 * randomPitch, 0.045, volume * 0.14, "square", 80);
    } else if (preset === "chew") {
      this.noiseBurst(now, 0.07, volume * 0.17, 1200, 260);
      this.tone(now + 0.015, 310 * randomPitch, 0.06, volume * 0.08, "sine", 210);
    } else if (preset === "dig" || preset === "tunnel") {
      this.noiseBurst(now, preset === "dig" ? 0.22 : 0.14, volume * 0.24, 620, 80);
      this.tone(now, preset === "dig" ? 105 : 150, 0.18, volume * 0.12, "triangle", 70);
    } else if (preset === "hurt") {
      this.tone(now, 240 * randomPitch, 0.12, volume * 0.25, "sawtooth", 120);
    } else if (preset === "heal" || preset === "merge") {
      const base = preset === "heal" ? 420 : 320;
      [0, 0.07, 0.14].forEach((offset, index) =>
        this.tone(now + offset, base * (1 + index * 0.25), 0.12, volume * 0.16, "sine"),
      );
    } else if (preset === "death") {
      this.tone(now, 210, 0.38, volume * 0.23, "sawtooth", 45);
      this.noiseBurst(now + 0.08, 0.26, volume * 0.18, 500, 70);
    } else if (preset === "lava") {
      this.noiseBurst(now, 0.3, volume * 0.08, 950, 260);
    } else if (preset === "spring") {
      [0, 0.08, 0.17].forEach((offset, index) =>
        this.tone(now + offset, 420 + index * 95, 0.1, volume * 0.1, "sine", 520 + index * 80),
      );
    } else if (preset === "pandaGrunt") {
      this.tone(now, 155 * randomPitch, 0.16, volume * 0.24, "triangle", 105);
      this.tone(now + 0.09, 125 * randomPitch, 0.14, volume * 0.18, "sine", 85);
    } else if (preset === "moleSqueak") {
      this.tone(now, 680 * randomPitch, 0.07, volume * 0.18, "square", 980);
      this.tone(now + 0.08, 820 * randomPitch, 0.06, volume * 0.14, "triangle", 560);
    }
  }

  private tone(
    start: number,
    frequency: number,
    duration: number,
    volume: number,
    shape: OscillatorShape,
    endFrequency?: number,
  ): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = shape;
    oscillator.frequency.setValueAtTime(Math.max(20, frequency), start);
    if (endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);
    }
    gain.gain.setValueAtTime(Math.max(0.0001, volume), start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private noiseBurst(
    start: number,
    duration: number,
    volume: number,
    highFrequency: number,
    lowFrequency: number,
  ): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const length = Math.ceil(context.sampleRate * duration);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      data[index] = (Math.random() * 2 - 1) * (1 - index / length);
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = buffer;
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(highFrequency, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(25, lowFrequency), start + duration);
    filter.Q.value = 0.8;
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(start);
  }

  private applyMasterVolume(): void {
    if (!this.master || !this.context) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.context.currentTime, 0.02);
  }
}
