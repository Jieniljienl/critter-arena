import type {
  AssetRef,
  BackgroundMusicConfig,
  CharacterDefinition,
  CombatEvent,
  RuntimeUnit,
  SoundCue,
} from "./types";

type OscillatorShape = OscillatorType;

export const isSkillVoiceEvent = (
  event: Pick<CombatEvent, "type" | "skillVoiceId">,
): boolean =>
  Boolean(event.skillVoiceId) &&
  (event.type === "skill" || event.type === "spawn");

export type ResolvedSkillVoice = {
  phrase: string;
  speechRate: number;
  speechPitch: number;
};

export const resolveSkillVoice = (
  cue: SoundCue,
  event: Pick<CombatEvent, "type" | "skillVoiceId" | "sound">,
): ResolvedSkillVoice | undefined => {
  if (cue.source !== "speech" || !isSkillVoiceEvent(event)) return undefined;
  const skillVoiceId = event.skillVoiceId!;
  const hasDedicatedProfile = Boolean(
    cue.skillVoices &&
      Object.prototype.hasOwnProperty.call(cue.skillVoices, skillVoiceId),
  );
  const dedicated = cue.skillVoices?.[skillVoiceId];
  if (hasDedicatedProfile) {
    const phrase = dedicated?.phrase.trim();
    if (!phrase) return undefined;
    return {
      phrase,
      speechRate: dedicated.speechRate ?? cue.speechRate ?? 1,
      speechPitch: dedicated.speechPitch ?? cue.speechPitch ?? 1,
    };
  }

  const legacyPhrase = (
    (event.sound ? cue.phrasesBySound?.[event.sound] : undefined) ??
    cue.phrases ??
    []
  )
    .map((phrase) => phrase.trim())
    .find(Boolean);
  if (!legacyPhrase) return undefined;
  return {
    phrase: legacyPhrase,
    speechRate: cue.speechRate ?? 1,
    speechPitch: cue.speechPitch ?? 1,
  };
};

export class ArenaAudio {
  private context?: AudioContext;
  private master?: GainNode;
  private muted = false;
  private volume = 0.72;
  private skillVoicesEnabled = true;
  private skillVoiceVolume = 0.78;
  private lastPlayed = new Map<string, number>();
  private soundWindowStartedAt = 0;
  private soundsInWindow = 0;
  private cueVoiceEnds = new Map<string, number[]>();
  private assetVoicePools = new Map<string, HTMLAudioElement[]>();
  private noiseBuffer?: AudioBuffer;
  private lastSpeechAt = 0;
  private musicGain?: GainNode;
  private musicSource?: AudioBufferSourceNode;
  private musicConfig?: BackgroundMusicConfig;
  private musicAssets: AssetRef[] = [];
  private musicLoadToken = 0;

  async unlock(): Promise<void> {
    if (typeof window === "undefined") return;
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      this.musicGain = this.context.createGain();
      this.musicGain.connect(this.master);
      this.applyMasterVolume();
      this.applyMusicVolume();
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

  setSkillVoicesEnabled(enabled: boolean): void {
    this.skillVoicesEnabled = enabled;
    if (!enabled && typeof window !== "undefined") window.speechSynthesis?.cancel();
  }

  setSkillVoiceVolume(volume: number): void {
    this.skillVoiceVolume = Math.max(0, Math.min(1, volume));
  }

  async setMusic(config: BackgroundMusicConfig, assets: AssetRef[]): Promise<void> {
    this.musicConfig = structuredClone(config);
    this.musicAssets = assets;
    this.applyMusicVolume();
    if (!this.context || this.context.state === "suspended") return;
    await this.restartMusic();
  }

  setMusicVolume(volume: number): void {
    if (!this.musicConfig) return;
    this.musicConfig.volume = Math.max(0, Math.min(1, volume));
    this.applyMusicVolume();
  }

  async startMusic(config: BackgroundMusicConfig, assets: AssetRef[]): Promise<void> {
    this.musicConfig = structuredClone(config);
    this.musicAssets = assets;
    await this.unlock();
    await this.restartMusic();
  }

  stopMusic(): void {
    this.musicLoadToken += 1;
    try {
      this.musicSource?.stop();
    } catch {
      // The source may already have naturally stopped.
    }
    this.musicSource?.disconnect();
    this.musicSource = undefined;
  }

  dispose(): void {
    this.stopMusic();
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    for (const pool of this.assetVoicePools.values()) {
      for (const audio of pool) {
        audio.pause();
        audio.currentTime = 0;
      }
    }
    void this.context?.close();
    this.context = undefined;
    this.master = undefined;
    this.musicGain = undefined;
    this.noiseBuffer = undefined;
    this.assetVoicePools.clear();
    this.cueVoiceEnds.clear();
    this.lastPlayed.clear();
  }

  async playEvent(
    event: CombatEvent,
    units: ReadonlyMap<string, RuntimeUnit>,
    definitions: ReadonlyMap<string, CharacterDefinition>,
    assets: ReadonlyMap<string, AssetRef>,
  ): Promise<void> {
    const unit = event.unitId ? units.get(event.unitId) : undefined;
    const definition = unit ? definitions.get(unit.definitionId) : undefined;
    const skillSpeechCue =
      isSkillVoiceEvent(event) && definition?.sounds.skill?.source === "speech"
        ? definition.sounds.skill
        : undefined;
    if ((!event.sound && !skillSpeechCue) || this.muted) return;
    await this.unlock();
    if (skillSpeechCue) this.playSpeech(skillSpeechCue, event);
    if (!event.sound) return;

    const now = performance.now();
    const ambient = event.sound === "lava" || event.sound === "spring";
    const key = `${event.sound}-${ambient ? "world" : event.unitId ?? "world"}`;
    const minimumGap = ambient ? 240 : event.sound === "gatling" ? 48 : 36;
    if (now - (this.lastPlayed.get(key) ?? 0) < minimumGap) return;
    if (!this.takeGlobalSoundSlot(now, ambient ? 4 : 14)) return;
    this.lastPlayed.set(key, now);
    if (this.lastPlayed.size > 512) {
      for (const [playedKey, playedAt] of this.lastPlayed) {
        if (now - playedAt > 5_000) this.lastPlayed.delete(playedKey);
      }
      while (this.lastPlayed.size > 768) {
        const oldestKey = this.lastPlayed.keys().next().value;
        if (oldestKey === undefined) break;
        this.lastPlayed.delete(oldestKey);
      }
    }

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
    const audibleCue = cue?.source === "speech" ? undefined : cue;
    const resolvedCue =
      audibleCue ?? {
        id: event.sound,
        source: "synth" as const,
        preset: event.sound,
        volume: ambient ? 0.24 : 0.7,
      };
    if (!this.takeCueVoiceSlot(resolvedCue, now)) return;
    if (audibleCue?.source === "asset" && audibleCue.assetId) {
      const asset = assets.get(audibleCue.assetId);
      if (asset) {
        this.playAssetCue(asset, audibleCue);
        return;
      }
    }
    this.playSynth(resolvedCue);
  }

  private takeGlobalSoundSlot(now: number, limit: number): boolean {
    if (now - this.soundWindowStartedAt >= 100) {
      this.soundWindowStartedAt = now;
      this.soundsInWindow = 0;
    }
    if (this.soundsInWindow >= limit) return false;
    this.soundsInWindow += 1;
    return true;
  }

  private takeCueVoiceSlot(cue: SoundCue, now: number): boolean {
    const maxVoices = Math.max(1, Math.min(16, cue.maxVoices ?? 8));
    const ends = (this.cueVoiceEnds.get(cue.id) ?? []).filter((end) => end > now);
    if (ends.length >= maxVoices) {
      this.cueVoiceEnds.set(cue.id, ends);
      return false;
    }
    ends.push(now + 650);
    this.cueVoiceEnds.set(cue.id, ends);
    return true;
  }

  private playAssetCue(asset: AssetRef, cue: SoundCue): void {
    const maxVoices = Math.max(1, Math.min(8, cue.maxVoices ?? 4));
    const pool = this.assetVoicePools.get(asset.id) ?? [];
    let audio = pool.find((candidate) => candidate.paused || candidate.ended);
    if (!audio && pool.length < maxVoices) {
      audio = new Audio(asset.url);
      audio.preload = "auto";
      pool.push(audio);
      this.assetVoicePools.set(asset.id, pool);
    }
    if (!audio) return;
    audio.currentTime = 0;
    audio.volume = Math.min(1, this.volume * cue.volume);
    void audio.play().catch(() => undefined);
  }

  private playSpeech(cue: SoundCue, event: CombatEvent): void {
    if (
      this.muted ||
      !this.skillVoicesEnabled ||
      typeof window === "undefined" ||
      !window.speechSynthesis ||
      performance.now() - this.lastSpeechAt < 850
    ) {
      return;
    }
    const resolvedVoice = resolveSkillVoice(cue, event);
    if (!resolvedVoice) return;
    this.lastSpeechAt = performance.now();
    const utterance = new SpeechSynthesisUtterance(resolvedVoice.phrase);
    utterance.lang = "zh-CN";
    utterance.rate = resolvedVoice.speechRate;
    utterance.pitch = resolvedVoice.speechPitch;
    utterance.volume = Math.min(
      1,
      this.volume * this.skillVoiceVolume * cue.volume,
    );
    const voice = this.preferredChineseVoice(cue.id);
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }

  private preferredChineseVoice(variant: string): SpeechSynthesisVoice | undefined {
    if (typeof window === "undefined" || !window.speechSynthesis) return undefined;
    const voices = window.speechSynthesis
      .getVoices()
      .filter((voice) => voice.lang.toLowerCase().startsWith("zh"))
      .map((voice) => {
        const identity = `${voice.name} ${voice.voiceURI}`.toLowerCase();
        let score = voice.lang.toLowerCase() === "zh-cn" ? 12 : 6;
        if (/natural|neural|online/.test(identity)) score += 24;
        if (
          /晓晓|晓伊|晓辰|晓涵|云希|xiaoxiao|xiaoyi|xiaohan|yunxi|hsiaochen/.test(
            identity,
          )
        ) {
          score += 18;
        }
        if (/microsoft|google|apple/.test(identity)) score += 5;
        if (!voice.localService) score += 4;
        return { voice, score };
      })
      .sort(
        (left, right) =>
          right.score - left.score || left.voice.name.localeCompare(right.voice.name),
      );
    if (!voices.length) return undefined;
    if (voices.length === 1) return voices[0].voice;
    const hash = [...variant].reduce(
      (total, character) => (total * 31 + character.charCodeAt(0)) >>> 0,
      0,
    );
    return voices[hash % Math.min(3, voices.length)].voice;
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
    } else if (preset === "reload") {
      this.tone(now, 170, 0.055, volume * 0.16, "square", 105);
      this.noiseBurst(now + 0.07, 0.075, volume * 0.16, 1350, 280);
      this.tone(now + 0.16, 115, 0.085, volume * 0.2, "triangle", 82);
      this.noiseBurst(now + 0.25, 0.06, volume * 0.12, 1900, 420);
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
      this.noiseBurst(now, 0.24, volume * 0.035, 620, 180);
      this.tone(now, 92, 0.22, volume * 0.025, "sine", 72);
    } else if (preset === "spring") {
      [0, 0.11].forEach((offset, index) =>
        this.tone(now + offset, 280 + index * 70, 0.16, volume * 0.045, "sine", 340 + index * 65),
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
    if (!this.noiseBuffer || this.noiseBuffer.sampleRate !== context.sampleRate) {
      const length = context.sampleRate;
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let index = 0; index < length; index += 1) {
        data[index] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = this.noiseBuffer;
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(highFrequency, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(25, lowFrequency), start + duration);
    filter.Q.value = 0.8;
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(start, Math.random() * Math.max(0, 1 - duration), duration);
  }

  private applyMasterVolume(): void {
    if (!this.master || !this.context) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.context.currentTime, 0.02);
  }

  private applyMusicVolume(): void {
    if (!this.musicGain || !this.context) return;
    const volume = this.musicConfig?.enabled ? this.musicConfig.volume : 0;
    this.musicGain.gain.setTargetAtTime(
      Math.max(0, Math.min(1, volume)),
      this.context.currentTime,
      0.08,
    );
  }

  private async restartMusic(): Promise<void> {
    const context = this.context;
    const musicGain = this.musicGain;
    const config = this.musicConfig;
    if (!context || !musicGain || !config) return;
    this.stopMusic();
    this.applyMusicVolume();
    if (!config.enabled) return;
    const token = ++this.musicLoadToken;
    let buffer: AudioBuffer;
    if (config.source === "asset" && config.assetId) {
      const asset = this.musicAssets.find((candidate) => candidate.id === config.assetId);
      if (!asset) return;
      try {
        const response = await fetch(asset.url);
        if (!response.ok) return;
        buffer = await context.decodeAudioData(await response.arrayBuffer());
      } catch {
        return;
      }
    } else {
      buffer = this.createDefaultMusicBuffer(context);
    }
    if (token !== this.musicLoadToken || !this.musicConfig?.enabled) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(musicGain);
    source.start();
    this.musicSource = source;
  }

  private createDefaultMusicBuffer(context: AudioContext): AudioBuffer {
    const duration = 16;
    const sampleRate = Math.min(24000, context.sampleRate);
    const buffer = context.createBuffer(2, duration * sampleRate, sampleRate);
    const melody = [64, 67, 71, 69, 64, 62, 59, 62, 64, 67, 74, 71, 69, 67, 64, 62];
    const bass = [40, 40, 43, 43, 45, 45, 43, 43];
    const midiToFrequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) {
        const time = index / sampleRate;
        const beat = Math.floor(time * 2) % melody.length;
        const beatPhase = (time * 2) % 1;
        const melodyEnvelope = Math.min(1, beatPhase * 8) * Math.max(0, 1 - beatPhase * 0.82);
        const melodyFrequency = midiToFrequency(melody[beat]);
        const bassFrequency = midiToFrequency(bass[Math.floor(time / 2) % bass.length]);
        const panDelay = channel === 0 ? 0 : 0.006;
        const softLead =
          Math.sin((time - panDelay) * melodyFrequency * Math.PI * 2) * melodyEnvelope * 0.055;
        const warmBass = Math.sin(time * bassFrequency * Math.PI * 2) * 0.04;
        const shimmer =
          Math.sin(time * melodyFrequency * 2 * Math.PI * 2) * melodyEnvelope * 0.012;
        const pulsePhase = (time * 4) % 1;
        const softPulse =
          Math.sin(time * 82 * Math.PI * 2) * Math.exp(-pulsePhase * 9) * 0.014;
        data[index] = Math.max(-0.16, Math.min(0.16, softLead + warmBass + shimmer + softPulse));
      }
    }
    return buffer;
  }
}
